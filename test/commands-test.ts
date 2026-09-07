import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ImapFlow } from '../src/imap-flow.js';

describe('commands', () => {
    it('Commands: Client instantiation', () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            auth: { user: 'test', pass: 'test' }
        });

        assert.ok(client);
        assert.equal(typeof client.exec, 'function');
    });
    it('Commands: Method availability', () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            auth: { user: 'test', pass: 'test' }
        });

        // Check that key IMAP methods exist
        assert.equal(typeof client.connect, 'function');
        assert.equal(typeof client.logout, 'function');
        assert.equal(typeof client.list, 'function');
        assert.equal(typeof client.mailboxOpen, 'function');
        assert.equal(typeof client.mailboxClose, 'function');
        assert.equal(typeof client.search, 'function');
        assert.equal(typeof client.fetch, 'function');
    });
    it('Commands: State management methods', () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            auth: { user: 'test', pass: 'test' }
        });

        assert.equal(typeof client.mailboxCreate, 'function');
        assert.equal(typeof client.mailboxDelete, 'function');
        assert.equal(typeof client.mailboxRename, 'function');
        assert.equal(typeof client.mailboxSubscribe, 'function');
        assert.equal(typeof client.mailboxUnsubscribe, 'function');
    });
    it('Commands: Message operation methods', () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            auth: { user: 'test', pass: 'test' }
        });

        assert.equal(typeof client.messageFlagsSet, 'function');
        assert.equal(typeof client.messageFlagsAdd, 'function');
        assert.equal(typeof client.messageFlagsRemove, 'function');
        assert.equal(typeof client.messageCopy, 'function');
        assert.equal(typeof client.messageMove, 'function');
        assert.equal(typeof client.messageDelete, 'function');
    });
    it('Commands: Utility methods', () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            auth: { user: 'test', pass: 'test' }
        });

        assert.equal(typeof client.noop, 'function');
        assert.equal(typeof client.getQuota, 'function');
        assert.equal(typeof client.stats, 'function');
        assert.equal(typeof client.getRandomId, 'function');
    });
});
