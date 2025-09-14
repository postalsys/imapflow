'use strict';

const { ImapFlow } = require('../lib/imap-flow');
const { AuthenticationFailure } = require('../lib/tools');

module.exports['Authentication: Password auth configuration'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        auth: {
            user: 'testuser',
            pass: 'testpass'
        }
    });

    test.equal(client.options.auth.user, 'testuser');
    test.equal(client.options.auth.pass, 'testpass');
    test.done();
};

module.exports['Authentication: OAuth2 auth configuration'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        auth: {
            user: 'testuser',
            accessToken: 'oauth2_token_here'
        }
    });

    test.equal(client.options.auth.user, 'testuser');
    test.equal(client.options.auth.accessToken, 'oauth2_token_here');
    test.done();
};

module.exports['Authentication: Login method specification'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        auth: {
            user: 'testuser',
            pass: 'testpass',
            loginMethod: 'AUTH=PLAIN'
        }
    });

    test.equal(client.options.auth.loginMethod, 'AUTH=PLAIN');
    test.done();
};

module.exports['Authentication: SASL PLAIN with authzid for impersonation'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        auth: {
            user: 'admin@example.com',
            pass: 'adminpass',
            authzid: 'user@example.com',
            loginMethod: 'AUTH=PLAIN'
        }
    });

    test.equal(client.options.auth.user, 'admin@example.com');
    test.equal(client.options.auth.pass, 'adminpass');
    test.equal(client.options.auth.authzid, 'user@example.com');
    test.equal(client.options.auth.loginMethod, 'AUTH=PLAIN');
    test.done();
};

module.exports['Authentication: AuthenticationFailure error structure'] = test => {
    let error = new AuthenticationFailure('Invalid credentials');

    test.ok(error instanceof Error);
    test.equal(error.constructor.name, 'AuthenticationFailure');
    test.equal(error.message, 'Invalid credentials');
    test.done();
};

module.exports['Authentication: Verify-only mode'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        auth: {
            user: 'testuser',
            pass: 'testpass'
        },
        verifyOnly: true
    });

    test.equal(client.options.verifyOnly, true);
    test.done();
};

module.exports['Authentication: Disable auto IDLE'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        auth: {
            user: 'testuser',
            pass: 'testpass'
        },
        disableAutoIdle: true
    });

    test.equal(client.options.disableAutoIdle, true);
    test.done();
};
