'use strict';

const { getStatusCode, getErrorText } = require('../tools.js');

// Authenticates user using LOGIN
module.exports = async (connection, username, accessToken) => {
    if (connection.state !== connection.states.NOT_AUTHENTICATED) {
        // nothing to do here
        return;
    }

    // AUTH=OAUTHBEARER and AUTH=XOAUTH in the context of OAuth2 or very similar so we can handle these together
    if (connection.capabilities.has('AUTH=OAUTHBEARER') || connection.capabilities.has('AUTH=XOAUTH') || connection.capabilities.has('AUTH=XOAUTH2')) {
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

    throw new Error('Unsupported authentication mechanism');
};
