import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ImapFlow } from '../../src/imap-flow.js';
import type { MailboxObject } from '../../src/types.js';

describe('commands/download', () => {
    it('Commands: download returns empty when no mailbox selected', async () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });
        // mailbox is not set by default
        let result = await client.download('1', '1.2');
        assert.deepEqual(result, {});
    });
    it('Commands: downloadMany returns empty when no mailbox selected', async () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });
        let result = await client.downloadMany('1', ['2', '3']);
        assert.deepEqual(result, {});
    });
    it('Commands: download with fetchOne returning null', async () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });
        // Set mailbox so download doesn't return {} early
        client.mailbox = { path: 'INBOX' } as MailboxObject;
        // Mock fetchOne to return null (message not found)
        (client as any).fetchOne = async () => null;

        // part '1' triggers the bodyStructure check path
        let result: any = await client.download('1', '1');
        assert.deepEqual(result, {}, 'a missing message resolves with the documented empty object');
    });
    it('Commands: downloadMany with fetchOne returning null', async () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });
        client.mailbox = { path: 'INBOX' } as MailboxObject;
        (client as any).fetchOne = async () => null;

        let result = await client.downloadMany('1', ['2', '3']);
        assert.deepEqual(result, {}, 'no phantom "response" entry among the parts');
    });
});
