'use strict';

const { getStatusCode, getErrorText } = require('../tools.js');

/**
 * Handles authentication errors by enriching the error object with server response details.
 *
 * @param {Error} err - The original authentication error
 * @param {Object} [errorResponse] - Optional OAuth error response from the server
 * @throws {Error} Always throws the enriched error
 */
async function handleAuthError(err, errorResponse) {
    let errorCode = getStatusCode(err.response);
    if (errorCode) {
        err.serverResponseCode = errorCode;
    }
    err.authenticationFailed = true;
    err.response = await getErrorText(err.response);
    if (errorResponse) {
        err.oauthError = errorResponse;
    }
    throw err;
}

/**
 * Authenticates using OAuth (OAUTHBEARER or XOAUTH2).
 *
 * @param {Object} connection - IMAP connection instance
 * @param {string} username - The username to authenticate with
 * @param {string} accessToken - The OAuth2 access token
 * @returns {Promise<string>} The authenticated username
 * @throws {Error} If authentication fails
 */
async function authOauth(connection, username, accessToken) {
    let oauthbearer;
    let command;
    let breaker;

    if (connection.capabilities.has('AUTH=OAUTHBEARER')) {
        // OAUTHBEARER payload per RFC 7628: fields separated by \x01 (SASL GS2 framing).
        // Format: "n,a=<user>," \x01 "host=..." \x01 "port=..." \x01 "auth=Bearer <token>" \x01 \x01
        // The trailing empty strings produce the required double-\x01 terminator.
        oauthbearer = [`n,a=${username},`, `host=${connection.servername}`, `port=993`, `auth=Bearer ${accessToken}`, '', ''].join('\x01');
        command = 'OAUTHBEARER';
        // "AQ==" is base64 for \x01 -- sent as the error continuation to abort the SASL exchange
        breaker = 'AQ==';
    } else if (connection.capabilities.has('AUTH=XOAUTH') || connection.capabilities.has('AUTH=XOAUTH2')) {
        // XOAUTH2 payload (Google-specific): simpler format, also \x01-delimited.
        // Format: "user=<user>" \x01 "auth=Bearer <token>" \x01 \x01
        oauthbearer = [`user=${username}`, `auth=Bearer ${accessToken}`, '', ''].join('\x01');
        command = 'XOAUTH2';
        // Empty breaker: XOAUTH2 expects an empty response to abort the SASL exchange
        breaker = '';
    }

    let errorResponse = false;
    try {
        let response = await connection.exec(
            'AUTHENTICATE',
            [
                { type: 'ATOM', value: command },
                { type: 'ATOM', value: Buffer.from(oauthbearer).toString('base64'), sensitive: true }
            ],
            {
                // Server sends a "+" continuation if auth fails, with a base64 JSON error payload.
                // We decode it for diagnostics, then send the breaker to terminate the exchange.
                onPlusTag: async resp => {
                    if (resp.attributes && resp.attributes[0] && resp.attributes[0].type === 'TEXT') {
                        try {
                            errorResponse = JSON.parse(Buffer.from(resp.attributes[0].value, 'base64').toString());
                        } catch (err) {
                            connection.log.debug({ errorResponse: resp.attributes[0].value, err });
                        }
                    }

                    connection.log.debug({ src: 'c', msg: breaker, comment: `Error response for ${command}` });
                    connection.write(breaker);
                }
            }
        );
        response.next();

        connection.authCapabilities.set(`AUTH=${command}`, true);

        return username;
    } catch (err) {
        await handleAuthError(err, errorResponse);
    }
}

/**
 * Authenticates using the SASL LOGIN mechanism.
 *
 * @param {Object} connection - IMAP connection instance
 * @param {string} username - The username to authenticate with
 * @param {string} password - The password to authenticate with
 * @returns {Promise<string>} The authenticated username
 * @throws {Error} If authentication fails
 */
async function authLogin(connection, username, password) {
    let errorResponse = false;
    try {
        // SASL LOGIN is a challenge-response mechanism: the server sends base64-encoded
        // prompts ("Username:" and "Password:") and the client responds with base64-encoded values.
        let response = await connection.exec('AUTHENTICATE', [{ type: 'ATOM', value: 'LOGIN' }], {
            onPlusTag: async resp => {
                if (resp.attributes && resp.attributes[0] && resp.attributes[0].type === 'TEXT') {
                    // Decode the server's base64 challenge to determine what it's asking for.
                    // Strip trailing colons and null bytes (\x00) that some servers append to the prompt.
                    let question = Buffer.from(resp.attributes[0].value, 'base64')
                        .toString()
                        .toLowerCase()
                        .replace(/[:\x00]*$/, ''); // eslint-disable-line no-control-regex

                    if (question === 'username' || question === 'user name') {
                        let encodedUsername = Buffer.from(username).toString('base64');
                        connection.log.debug({ src: 'c', msg: encodedUsername, comment: `Encoded username for AUTH=LOGIN` });
                        connection.write(encodedUsername);
                    } else if (question === 'password') {
                        connection.log.debug({ src: 'c', msg: '(* value hidden *)', comment: `Encoded password for AUTH=LOGIN` });
                        connection.write(Buffer.from(password).toString('base64'));
                    } else {
                        throw new Error(`Unknown LOGIN question "${question}"`);
                    }
                }
            }
        });

        response.next();

        connection.authCapabilities.set(`AUTH=LOGIN`, true);

        return username;
    } catch (err) {
        await handleAuthError(err, errorResponse);
    }
}

/**
 * Authenticates using the SASL PLAIN mechanism.
 *
 * @param {Object} connection - IMAP connection instance
 * @param {string} username - The authentication identity (authcid)
 * @param {string} password - The password to authenticate with
 * @param {string} [authzid] - Optional authorization identity to impersonate
 * @returns {Promise<string>} The authorized identity (authzid if provided, otherwise username)
 * @throws {Error} If authentication fails
 */
async function authPlain(connection, username, password, authzid) {
    let errorResponse = false;
    try {
        let response = await connection.exec('AUTHENTICATE', [{ type: 'ATOM', value: 'PLAIN' }], {
            onPlusTag: async () => {
                // SASL PLAIN format: [authzid]\x00authcid\x00password
                // authzid: authorization identity (who to impersonate)
                // authcid: authentication identity (who is authenticating)
                let authzidValue = authzid || '';
                let encodedResponse = Buffer.from([authzidValue, username, password].join('\x00')).toString('base64');
                let loggedResponse = Buffer.from([authzidValue, username, '(* value hidden *)'].join('\x00')).toString('base64');
                connection.log.debug({ src: 'c', msg: loggedResponse, comment: `Encoded response for AUTH=PLAIN${authzid ? ' with authzid' : ''}` });
                connection.write(encodedResponse);
            }
        });

        response.next();

        connection.authCapabilities.set(`AUTH=PLAIN`, true);

        // Return the identity we're authorized as (authzid if provided, otherwise username)
        return authzid || username;
    } catch (err) {
        await handleAuthError(err, errorResponse);
    }
}

/**
 * Authenticates user using the best available method.
 *
 * @param {Object} connection - IMAP connection instance
 * @param {string} username - The username to authenticate with
 * @param {Object} credentials - Authentication credentials
 * @param {string} [credentials.accessToken] - OAuth2 access token for OAUTHBEARER/XOAUTH2 authentication
 * @param {string} [credentials.password] - Password for PLAIN or LOGIN authentication
 * @param {string} [credentials.loginMethod] - Force a specific login method (e.g., 'AUTH=PLAIN', 'AUTH=LOGIN')
 * @param {string} [credentials.authzid] - Authorization identity for PLAIN authentication
 * @returns {Promise<string|undefined>} The authenticated username, or undefined if already authenticated
 * @throws {Error} If no supported authentication mechanism is available or if authentication fails
 */
module.exports = async (connection, username, { accessToken, password, loginMethod, authzid }) => {
    if (connection.state !== connection.states.NOT_AUTHENTICATED) {
        // nothing to do here
        return;
    }

    // Authentication method selection order:
    // 1. OAuth (OAUTHBEARER > XOAUTH2) -- preferred when an accessToken is provided,
    //    as it avoids transmitting passwords entirely.
    // 2. SASL PLAIN -- preferred over LOGIN because it supports authzid (impersonation)
    //    and sends credentials in a single round trip.
    // 3. SASL LOGIN -- fallback; an older challenge-response mechanism (two round trips).
    // If loginMethod is explicitly set, it overrides the automatic capability-based selection.

    if (accessToken) {
        // AUTH=OAUTHBEARER and AUTH=XOAUTH in the context of OAuth2 or very similar so we can handle these together
        if (connection.capabilities.has('AUTH=OAUTHBEARER') || connection.capabilities.has('AUTH=XOAUTH') || connection.capabilities.has('AUTH=XOAUTH2')) {
            return await authOauth(connection, username, accessToken);
        }
    }

    if (password) {
        if ((!loginMethod && connection.capabilities.has('AUTH=PLAIN')) || loginMethod === 'AUTH=PLAIN') {
            return await authPlain(connection, username, password, authzid);
        }

        if ((!loginMethod && connection.capabilities.has('AUTH=LOGIN')) || loginMethod === 'AUTH=LOGIN') {
            return await authLogin(connection, username, password);
        }
    }

    throw new Error('Unsupported authentication mechanism');
};
