import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ImapFlow } from '../src/imap-flow.js';

describe('connection', () => {
    it('Connection: Basic connection options', () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        assert.equal(client.host, 'imap.example.com');
        assert.equal(client.port, 993);
    });
    it('Connection: Default options', () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            auth: { user: 'test', pass: 'test' }
        });

        assert.equal(client.port, 143);
        assert.equal(client.secureConnection, false);
    });
    it('Connection: Secure connection defaults', () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        assert.equal(client.secureConnection, true);
    });
    it('Connection: TLS options', () => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            auth: { user: 'test', pass: 'test' },
            tls: {
                rejectUnauthorized: false,
                minVersion: 'TLSv1.3'
            }
        });

        assert.equal(client.options.tls.rejectUnauthorized, false);
        assert.equal(client.options.tls!.minVersion, 'TLSv1.3');
    });
    it('Connection: Authentication options', () => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            auth: {
                user: 'testuser',
                pass: 'testpass',
                accessToken: 'token123'
            }
        });

        assert.equal(client.options.auth.user, 'testuser');
        assert.equal(client.options.auth!.pass, 'testpass');
        assert.equal(client.options.auth!.accessToken, 'token123');
    });
    it('Connection: Proxy configuration', () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            auth: { user: 'test', pass: 'test' },
            proxy: 'socks5://proxy.example.com:1080'
        });

        assert.equal(client.options.proxy, 'socks5://proxy.example.com:1080');
    });
    it('Connection: Client info', () => {
        let clientInfo = {
            name: 'Test Client',
            version: '1.0.0',
            vendor: 'Test Corp'
        };

        let client = new ImapFlow({
            host: 'imap.example.com',
            auth: { user: 'test', pass: 'test' },
            clientInfo
        });

        assert.equal(client.clientInfo.name, 'Test Client');
        assert.equal(client.clientInfo.version, '1.0.0');
        assert.equal(client.clientInfo.vendor, 'Test Corp');
    });
    it('Connection: Logger configuration', () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            auth: { user: 'test', pass: 'test' },
            logger: false
        });

        assert.equal(client.options.logger, false);
    });
    it('Connection: Stats tracking', () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            auth: { user: 'test', pass: 'test' }
        });

        let stats = client.stats();
        assert.ok(Object.prototype.hasOwnProperty.call(stats, 'sent'));
        assert.ok(Object.prototype.hasOwnProperty.call(stats, 'received'));
        assert.equal(typeof stats.sent, 'number');
        assert.equal(typeof stats.received, 'number');
    });
    it('Connection: Random ID generation', () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            auth: { user: 'test', pass: 'test' }
        });

        let id1 = client.getRandomId();
        let id2 = client.getRandomId();

        assert.ok(typeof id1 === 'string' && id1.length > 0);
        assert.ok(typeof id2 === 'string' && id2.length > 0);
        assert.notEqual(id1, id2, 'IDs should be unique');
    });
    it('Connection: State management', () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            auth: { user: 'test', pass: 'test' }
        });

        assert.equal(client.state, client.states.NOT_AUTHENTICATED);
        assert.equal(client.authenticated, false);
        assert.ok(client.capabilities instanceof Map);
    });
    it('Connection: Event emitter setup', () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            auth: { user: 'test', pass: 'test' }
        });

        assert.equal(typeof client.on, 'function');
        assert.equal(typeof client.emit, 'function');
        assert.equal(typeof client.removeListener, 'function');
    });
});
