import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ImapFlow } from '../src/imap-flow.js';

describe('integration', () => {
    it('Integration: Basic client creation', () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            auth: { user: 'test', pass: 'test' }
        });

        assert.ok(client);
        assert.equal(client.state, client.states.NOT_AUTHENTICATED);
        assert.equal(client.authenticated, false);
    });
    it('Integration: Multiple client instances', () => {
        let client1 = new ImapFlow({
            host: 'imap1.example.com',
            auth: { user: 'test1', pass: 'test1' }
        });

        let client2 = new ImapFlow({
            host: 'imap2.example.com',
            auth: { user: 'test2', pass: 'test2' }
        });

        assert.ok(client1);
        assert.ok(client2);
        assert.notEqual(client1.id, client2.id);
    });
    it('Integration: Client configuration', () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            secure: true,
            auth: { user: 'test', pass: 'test' },
            logger: false
        });

        assert.equal(client.host, 'imap.example.com');
        assert.equal(client.port, 993);
        assert.equal(client.secureConnection, true);
    });
    it('Integration: Event emitter functionality', (t, done) => {
        let client: any[] = new ImapFlow({
            host: 'imap.example.com',
            auth: { user: 'test', pass: 'test' }
        }) as any;

        let eventFired = false;
        (client as any).on('test-event', () => {
            eventFired = true;
        });

        (client as any).emit('test-event');

        setTimeout(() => {
            assert.ok(eventFired);
            done();
        }, 10);
    });
    it('Integration: Stats functionality', () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            auth: { user: 'test', pass: 'test' }
        });

        let stats = client.stats();
        assert.ok(typeof stats === 'object');
        assert.ok(Object.prototype.hasOwnProperty.call(stats, 'sent'));
        assert.ok(Object.prototype.hasOwnProperty.call(stats, 'received'));

        // Reset stats
        let resetStats = client.stats(true);
        assert.ok(typeof resetStats === 'object');
    });
});
