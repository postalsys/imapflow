import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ImapFlow } from '../src/imap-flow.js';
import { AuthenticationFailure } from '../src/tools.js';

describe('authentication', () => {
    it('Authentication: Password auth configuration', () => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            auth: {
                user: 'testuser',
                pass: 'testpass'
            }
        });

        assert.equal(client.options.auth.user, 'testuser');
        assert.equal(client.options.auth!.pass, 'testpass');
    });
    it('Authentication: OAuth2 auth configuration', () => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            auth: {
                user: 'testuser',
                accessToken: 'oauth2_token_here'
            }
        });

        assert.equal(client.options.auth.user, 'testuser');
        assert.equal(client.options.auth!.accessToken, 'oauth2_token_here');
    });
    it('Authentication: Login method specification', () => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            auth: {
                user: 'testuser',
                pass: 'testpass',
                loginMethod: 'AUTH=PLAIN'
            }
        });

        assert.equal(client.options.auth.loginMethod, 'AUTH=PLAIN');
    });
    it('Authentication: SASL PLAIN with authzid for impersonation', () => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            auth: {
                user: 'admin@example.com',
                pass: 'adminpass',
                authzid: 'user@example.com',
                loginMethod: 'AUTH=PLAIN'
            }
        });

        assert.equal(client.options.auth.user, 'admin@example.com');
        assert.equal(client.options.auth!.pass, 'adminpass');
        assert.equal(client.options.auth!.authzid, 'user@example.com');
        assert.equal(client.options.auth!.loginMethod, 'AUTH=PLAIN');
    });
    it('Authentication: AuthenticationFailure error structure', () => {
        let error = new AuthenticationFailure('Invalid credentials');

        assert.ok(error instanceof Error);
        assert.equal(error.constructor.name, 'AuthenticationFailure');
        assert.equal(error.message, 'Invalid credentials');
    });
    it('Authentication: Verify-only mode', () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            auth: {
                user: 'testuser',
                pass: 'testpass'
            },
            verifyOnly: true
        });

        assert.equal(client.options.verifyOnly, true);
    });
    it('Authentication: Disable auto IDLE', () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            auth: {
                user: 'testuser',
                pass: 'testpass'
            },
            disableAutoIdle: true
        });

        assert.equal(client.options.disableAutoIdle, true);
    });
});
