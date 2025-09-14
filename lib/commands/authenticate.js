'use strict';

const { getStatusCode, getErrorText } = require('../tools.js');

async function authOauth(connection, username, accessToken) {
    let oauthbearer;
    let command;
    let breaker;

    if (connection.capabilities.has('AUTH=OAUTHBEARER')) {
        oauthbearer = [`n,a=${username},`, `host=${connection.servername}`, `port=993`, `auth=Bearer ${accessToken}`, '', ''].join('\x01');
        command = 'OAUTHBEARER';
        breaker = 'AQ==';
    } else if (connection.capabilities.has('AUTH=XOAUTH') || connection.capabilities.has('AUTH=XOAUTH2')) {
        oauthbearer = [`user=${username}`, `auth=Bearer ${accessToken}`, '', ''].join('\x01');
        command = 'XOAUTH2';
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
}

async function authLogin(connection, username, password) {
    let errorResponse = false;
    try {
        let response = await connection.exec('AUTHENTICATE', [{ type: 'ATOM', value: 'LOGIN' }], {
            onPlusTag: async resp => {
                if (resp.attributes && resp.attributes[0] && resp.attributes[0].type === 'TEXT') {
                    let question = Buffer.from(resp.attributes[0].value, 'base64').toString();
                    switch (
                        question.toLowerCase().replace(/[:\x00]*$/, '') // eslint-disable-line no-control-regex
                    ) {
                        case 'username':
                        case 'user name': {
                            let encodedUsername = Buffer.from(username).toString('base64');
                            connection.log.debug({ src: 'c', msg: encodedUsername, comment: `Encoded username for AUTH=LOGIN` });
                            connection.write(encodedUsername);
                            break;
                        }

                        case 'password':
                            connection.log.debug({ src: 'c', msg: '(* value hidden *)', comment: `Encoded password for AUTH=LOGIN` });
                            connection.write(Buffer.from(password).toString('base64'));
                            break;

                        default: {
                            let error = new Error(`Unknown LOGIN question "${question}"`);
                            throw error;
                        }
                    }
                }
            }
        });

        response.next();

        connection.authCapabilities.set(`AUTH=LOGIN`, true);

        return username;
    } catch (err) {
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
}

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
}

// Authenticates user using LOGIN
module.exports = async (connection, username, { accessToken, password, loginMethod, authzid }) => {
    if (connection.state !== connection.states.NOT_AUTHENTICATED) {
        // nothing to do here
        return;
    }

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
