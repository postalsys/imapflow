import { getStatusCode, getErrorText } from '../tools.js';
import type { ImapFlow } from '../imap-flow.js';

/**
 * Authenticates user using the IMAP LOGIN command.
 *
 * @param connection - IMAP connection instance
 * @param username - The username to authenticate with
 * @param password - The password to authenticate with
 * @returns The authenticated username, or undefined if already authenticated
 * @throws If authentication fails, with authenticationFailed and serverResponseCode properties set
 */
export default async function login(connection: ImapFlow, username: string, password: string): Promise<string | undefined> {
    if (connection.state !== connection.states.NOT_AUTHENTICATED) {
        // nothing to do here
        return;
    }

    try {
        let response = await connection.exec('LOGIN', [
            { type: 'STRING', value: username },
            // sensitive: true prevents the password from appearing in debug logs
            { type: 'STRING', value: password, sensitive: true }
        ]);
        response.next();

        // Record that LOGIN was the method used, so the connection knows which
        // auth mechanism succeeded (used for reconnection and diagnostics).
        connection.authCapabilities.set('LOGIN', true);

        return username;
    } catch (err: any) {
        let errorCode = getStatusCode(err.response);
        if (errorCode) {
            err.serverResponseCode = errorCode;
        }
        err.authenticationFailed = true;
        err.response = await getErrorText(err.response);
        throw err;
    }
}
