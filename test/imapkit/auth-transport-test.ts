import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startImapKit } from '../fixtures/imapkit.js';

// Login mechanisms, STARTTLS, implicit TLS and COMPRESS against servers that advertise exactly the
// mechanisms a case needs, something a fixed Docker server can not offer per test.

describe('imapkit: authentication', () => {
    it('LOGIN on a server without AUTH mechanisms', async t => {
        const kit = await startImapKit(t, { server: { plugins: [] } });
        const client = await kit.connect();
        assert.ok(client.authenticated);
        assert.ok(kit.sent(/^\S+ LOGIN /));
        assert.ok(!kit.sent('AUTHENTICATE'));
        await client.logout();
    });

    it('LOGIN failure rejects with AuthenticationFailure', async t => {
        const kit = await startImapKit(t, { server: { plugins: [] } });
        await assert.rejects(kit.connect({ auth: { user: 'testuser', pass: 'wrong' } }), (err: any) => {
            assert.equal(err.authenticationFailed, true);
            assert.equal(err.serverResponseCode, 'AUTHENTICATIONFAILED');
            return true;
        });
    });

    for (const saslIR of [true, false]) {
        it(`AUTH=PLAIN waits for the continuation (SASL-IR ${saslIR ? 'advertised' : 'not advertised'})`, async t => {
            // ImapFlow never sends an initial response for PLAIN, which is valid with and without SASL-IR
            const kit = await startImapKit(t, { server: { plugins: saslIR ? ['AUTH-PLAIN', 'SASL-IR'] : ['AUTH-PLAIN'] } });
            const client = await kit.connect();
            assert.ok(client.authenticated);
            assert.ok(kit.sent(/^\S+ AUTHENTICATE PLAIN$/));
            await client.logout();
        });
    }

    it('AUTH=PLAIN failure and a refused authzid both reject with AuthenticationFailure', async t => {
        const kit = await startImapKit(t, { server: { plugins: ['AUTH-PLAIN', 'SASL-IR'] } });
        await assert.rejects(kit.connect({ auth: { user: 'testuser', pass: 'wrong' } }), (err: any) => {
            assert.equal(err.authenticationFailed, true);
            assert.equal(err.serverResponseCode, 'AUTHENTICATIONFAILED');
            return true;
        });
        await assert.rejects(kit.connect({ auth: { user: 'testuser', pass: 'testpass', authzid: 'someoneelse' } }), (err: any) => {
            assert.equal(err.authenticationFailed, true);
            assert.equal(err.serverResponseCode, 'AUTHORIZATIONFAILED');
            return true;
        });
    });

    it('loginMethod LOGIN overrides an advertised AUTH=PLAIN', async t => {
        const kit = await startImapKit(t, { server: { plugins: ['AUTH-PLAIN', 'SASL-IR'] } });
        const client = await kit.connect({ auth: { user: 'testuser', pass: 'testpass', loginMethod: 'LOGIN' } });
        assert.ok(kit.sent(/^\S+ LOGIN /));
        assert.ok(!kit.sent('AUTHENTICATE'));
        await client.logout();
    });

    it('UTF-8 credentials go through AUTHENTICATE PLAIN', async t => {
        // RFC 9755 section 5: LOGIN does not take 8-bit user names or passwords, ImapKit answers BAD
        const kit = await startImapKit(t, {
            server: { plugins: ['AUTH-PLAIN', 'SASL-IR'], users: { 'jõgi@näide.ee': { password: 'pässwörd' } } }
        });
        const client = await kit.connect({ auth: { user: 'jõgi@näide.ee', pass: 'pässwörd' } });
        assert.ok(client.authenticated);
        await client.logout();
    });

    it('several users from the users option', async t => {
        const kit = await startImapKit(t, {
            server: { plugins: ['AUTH-PLAIN'], users: { alice: { password: 'a-pass' }, bob: { password: 'b-pass' } } }
        });
        const alice = await kit.connect({ auth: { user: 'alice', pass: 'a-pass' } });
        const bob = await kit.connect({ auth: { user: 'bob', pass: 'b-pass' } });
        assert.ok(alice.authenticated);
        assert.ok(bob.authenticated);
        await assert.rejects(kit.connect({ auth: { user: 'testuser', pass: 'testpass' } }), (err: any) => {
            assert.equal(err.authenticationFailed, true);
            return true;
        });
        await alice.logout();
        await bob.logout();
    });

    it('XOAUTH2', async t => {
        const kit = await startImapKit(t, { server: { plugins: ['XOAUTH2', 'SASL-IR'] } });
        const client = await kit.connect({ auth: { user: 'testuser', accessToken: 'testtoken' } });
        assert.ok(client.authenticated);
        assert.ok(kit.sent(/^\S+ AUTHENTICATE XOAUTH2 /));
        await client.logout();
    });

    it('XOAUTH2 failure', async t => {
        const kit = await startImapKit(t, { server: { plugins: ['XOAUTH2', 'SASL-IR'] } });
        await assert.rejects(kit.connect({ auth: { user: 'testuser', accessToken: 'expired' } }), (err: any) => {
            assert.equal(err.authenticationFailed, true);
            return true;
        });
    });

    it('OAUTHBEARER is preferred over XOAUTH2', async t => {
        const kit = await startImapKit(t, { server: { plugins: ['XOAUTH2', 'OAUTHBEARER', 'SASL-IR'] } });
        const client = await kit.connect({ auth: { user: 'testuser', accessToken: 'testtoken' } });
        assert.ok(client.authenticated);
        assert.ok(kit.sent(/^\S+ AUTHENTICATE OAUTHBEARER /));
        await client.logout();
    });

    it('OAUTHBEARER without SASL-IR', async t => {
        const kit = await startImapKit(t, { server: { plugins: ['OAUTHBEARER'] } });
        const client = await kit.connect({ auth: { user: 'testuser', accessToken: 'testtoken' } });
        assert.ok(client.authenticated);
        assert.ok(kit.sent(/^\S+ AUTHENTICATE OAUTHBEARER$/));
        await client.logout();
    });

    it('OAUTHBEARER failure answers the error challenge and rejects', async t => {
        // RFC 7628 section 3.2.3: the server sends the JSON error as a challenge, the client must
        // answer with a single %x01 before the server sends the tagged NO
        const kit = await startImapKit(t, { server: { plugins: ['OAUTHBEARER', 'SASL-IR'] } });
        await assert.rejects(kit.connect({ auth: { user: 'testuser', accessToken: 'expired' } }), (err: any) => {
            assert.equal(err.authenticationFailed, true);
            assert.equal(err.serverResponseCode, 'AUTHENTICATIONFAILED');
            return true;
        });
    });

    it('verifyOnly logs in and out', async t => {
        const kit = await startImapKit(t);
        const client = await kit.connect({ verifyOnly: true });
        assert.ok(client.authenticated);
        assert.ok(kit.sent(/^\S+ LOGOUT$/));
    });
});

describe('imapkit: transport', () => {
    it('STARTTLS upgrade with a fresh CAPABILITY after it', async t => {
        const kit = await startImapKit(t, { server: { plugins: ['STARTTLS', 'AUTH-PLAIN'] } });
        const client = await kit.connect();
        assert.ok(client.secureConnection, 'connection upgraded');
        assert.ok(kit.sent(/^\S+ STARTTLS$/));
        assert.ok(!client.capabilities.has('STARTTLS'), 'capabilities refreshed after the upgrade');
        await client.logout();
    });

    it('doSTARTTLS false stays on cleartext', async t => {
        const kit = await startImapKit(t, { server: { plugins: ['STARTTLS'] } });
        const client = await kit.connect({ doSTARTTLS: false });
        assert.ok(!client.secureConnection);
        assert.ok(!kit.sent('STARTTLS'));
        await client.logout();
    });

    it('doSTARTTLS true fails when the server has no STARTTLS', async t => {
        const kit = await startImapKit(t, { server: { plugins: [] } });
        await assert.rejects(kit.connect({ doSTARTTLS: true }), (err: any) => {
            assert.ok(err instanceof Error);
            return true;
        });
        assert.ok(!kit.sent(/ LOGIN /), 'credentials are never sent in cleartext');
    });

    it('LOGINDISABLED before STARTTLS, LOGIN after it', async t => {
        const kit = await startImapKit(t, { server: { plugins: ['STARTTLS', 'LOGINDISABLED'] } });
        const client = await kit.connect();
        assert.ok(client.secureConnection);
        assert.ok(!client.capabilities.has('LOGINDISABLED'));
        assert.ok(kit.sent(/^\S+ LOGIN /));
        await client.logout();
    });

    it('LOGINDISABLED without STARTTLS fails without sending the password', async t => {
        const kit = await startImapKit(t, { server: { plugins: ['STARTTLS', 'LOGINDISABLED'] } });
        await assert.rejects(kit.connect({ doSTARTTLS: false }), (err: any) => {
            assert.equal(err.authenticationFailed, true);
            assert.match(err.message, /Login is disabled/);
            return true;
        });
        assert.ok(!kit.sent(/ LOGIN /));
    });

    for (const secureConnection of [true, false]) {
        // servername is false for an IP literal host and must not reach tls.connect(), which Bun
        // rejects with "servername argument must be an string"
        it(`TLS to an IP literal host (${secureConnection ? 'implicit TLS' : 'STARTTLS'})`, async t => {
            const kit = await startImapKit(t, { server: { plugins: ['STARTTLS'], secureConnection } });
            const client = await kit.connect();
            assert.equal(client.servername, false);
            assert.ok(client.secureConnection);
            await client.logout();
        });
    }

    it('implicit TLS', async t => {
        const kit = await startImapKit(t, { server: { plugins: ['AUTH-PLAIN'], secureConnection: true } });
        const client = await kit.connect();
        assert.ok(client.secureConnection);
        assert.ok(client.tls && client.tls.version, 'TLS details exposed');
        assert.ok(!kit.sent('STARTTLS'));
        await client.logout();
    });

    it('COMPRESS=DEFLATE after login, also over TLS', async t => {
        const kit = await startImapKit(t, { server: { plugins: ['COMPRESS', 'STARTTLS', 'IDLE'] } });
        const client = await kit.connect();
        assert.ok(kit.sent(/^\S+ COMPRESS DEFLATE$/));
        // enough traffic for several deflate blocks in both directions
        for (let i = 0; i < 20; i++) {
            await client.append('INBOX', `Subject: compressed ${i}\r\n\r\n${'x'.repeat(10000)}\r\n`);
        }
        await client.mailboxOpen('INBOX');
        const messages = await client.fetchAll('1:*', { source: true });
        assert.equal(messages.length, 20);
        assert.ok(messages.every((message: any) => message.source.length > 10000));
        await client.logout();
    });

    it('disableCompression skips COMPRESS', async t => {
        const kit = await startImapKit(t, { server: { plugins: ['COMPRESS'] } });
        const client = await kit.connect({ disableCompression: true });
        assert.ok(!kit.sent('COMPRESS'));
        await client.logout();
    });

    it('ID exchange exposes the server info', async t => {
        const kit = await startImapKit(t, { server: { plugins: ['ID'], id: { name: 'ImapKit', version: '4' } } });
        const client = await kit.connect({ clientInfo: { name: 'imapflow-test' } });
        assert.ok(kit.sent(/^\S+ ID \(.*"name" "imapflow-test"/i));
        assert.equal(client.serverInfo.name, 'ImapKit');
        assert.equal(client.serverInfo.version, '4');
        await client.logout();
    });
});
