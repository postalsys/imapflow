import type { ImapFlow, ExecResponse } from '../imap-flow.js';

/**
 * Logs out the user and closes the connection.
 *
 * @param connection - IMAP connection instance
 * @returns True if logout command succeeded, false otherwise
 */
export default async function logout(connection: ImapFlow): Promise<boolean> {
    if (connection.state === connection.states.LOGOUT) {
        // nothing to do here
        return false;
    }

    if (connection.state === connection.states.NOT_AUTHENTICATED) {
        // Not yet authenticated, no LOGOUT command needed; just close the socket.
        connection.state = connection.states.LOGOUT;
        connection.close();
        return false;
    }

    let response: ExecResponse | undefined;
    try {
        response = await connection.exec('LOGOUT');
        return true;
    } catch (err: any) {
        // If the connection is already gone, treat as successful logout
        if (err.code === 'NoConnection') {
            return true;
        }
        connection.log.warn({ err, cid: connection.id });
        return false;
        /* c8 ignore next */ // the catch above is exhaustive (never re-throws), so finally is only ever reached via normal completion
    } finally {
        // Set state to LOGOUT before closing to prevent any further commands from
        // being queued. The socket is closed unconditionally in this finally block
        // regardless of whether the LOGOUT command succeeded or failed.
        connection.state = connection.states.LOGOUT;
        if (response && typeof response.next === 'function') {
            response.next();
        }
        connection.close();
    }
}
