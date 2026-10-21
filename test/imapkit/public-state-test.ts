import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startImapKit } from '../fixtures/imapkit.js';

// Public connection state an application reads instead of reaching into internals: the listing
// of a verifyOnly connection, an application context, when the connection was made and when the
// client last wrote to the server, and idle() inside a mailbox lock.

const PLUGINS = ['IDLE', 'NAMESPACE', 'UIDPLUS', 'ENABLE', 'CONDSTORE'];

describe('imapkit: public connection state', () => {
    it('mailboxList holds the listing of a verifyOnly connection with includeMailboxes', async t => {
        const kit = await startImapKit(t, { server: { plugins: PLUGINS } });
        const client = await kit.connect({ verifyOnly: true, includeMailboxes: true });
        assert.ok(Array.isArray(client.mailboxList));
        assert.ok(client.mailboxList.some((entry: any) => entry.path === 'INBOX'));
        assert.equal(client.mailboxList, client._mailboxList, 'the internal property is kept');

        const plain = await kit.connect({ verifyOnly: true });
        assert.equal(plain.mailboxList, undefined, 'nothing is listed without includeMailboxes');
    });

    it('context starts as the context option and is writable', async t => {
        const kit = await startImapKit(t, { server: { plugins: PLUGINS } });
        const account = { id: 'account-1' };
        const client = await kit.connect({ context: account });
        assert.equal(client.context, account);
        client.context = { id: 'account-2' };
        assert.deepEqual(client.context, { id: 'account-2' });

        const other = await kit.connect();
        assert.equal(other.context, undefined);
        await client.logout();
        await other.logout();
    });

    it('connectedAt is set when the connection is established and kept after close', async t => {
        const kit = await startImapKit(t, { server: { plugins: PLUGINS } });
        let before = 0;
        let unconnected: any = null;
        const client = await kit.connect({}, created => {
            unconnected = created.connectedAt;
            before = Date.now();
        });
        const after = Date.now();
        assert.equal(unconnected, null);
        assert.equal(typeof client.connectedAt, 'number');
        assert.ok(client.connectedAt >= before && client.connectedAt <= after);
        const connectedAt = client.connectedAt;
        await client.logout();
        assert.equal(client.connectedAt, connectedAt);
    });

    it('lastClientWrite follows every write: commands and the DONE that ends IDLE', async t => {
        const kit = await startImapKit(t, { server: { plugins: PLUGINS } });
        let unconnected: any = 0;
        const client = await kit.connect({}, created => {
            unconnected = created.lastClientWrite;
        });
        assert.equal(unconnected, null);
        assert.equal(typeof client.lastClientWrite, 'number', 'the session setup wrote');

        await client.mailboxOpen('INBOX');
        const waiting = kit.serverEvent('session', (event: any) => event.type === 'waiting' && event.command === 'IDLE');
        const idling = client.idle();
        await waiting;
        const idleWrite = client.lastClientWrite;

        await new Promise(resolve => setTimeout(resolve, 5));
        // breaking IDLE writes DONE before the NOOP itself
        const writes: number[] = [];
        const write = client.write.bind(client);
        client.write = (chunk: any) => {
            write(chunk);
            writes.push(client.lastClientWrite);
        };
        await client.noop();
        await idling;
        assert.ok(writes.length >= 2, 'DONE and NOOP were written');
        for (const value of writes) {
            assert.ok(value > idleWrite, 'each write moved lastClientWrite');
        }
        await client.logout();
    });

    it('idle() called by the holder of a mailbox lock starts IDLE inside that lock', async t => {
        // The Workers, celld and browser harnesses idle this way. idle() can not tell the holder
        // from another caller, so waiting for a free connection there hung the holder forever
        const kit = await startImapKit(t, { server: { plugins: PLUGINS } });
        const client = await kit.connect();
        const lock = await client.getMailboxLock('INBOX');
        try {
            const waiting = kit.serverEvent('session', (event: any) => event.type === 'waiting' && event.command === 'IDLE');
            const exists = new Promise<any>(resolve => client.once('exists', resolve));
            const idling = client.idle();
            await waiting;
            assert.equal(client.idling, true);
            kit.control.addMessage('INBOX', { raw: 'Subject: pushed\r\n\r\nHello\r\n' });
            const event = await exists;
            assert.equal(event.count, event.prevCount + 1);
            await client.noop();
            await idling;
        } finally {
            lock.release();
        }
        await client.logout();
    });
});
