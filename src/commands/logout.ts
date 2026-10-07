import { clearTimer } from '../tools.js';
import type { ImapFlow, ExecResponse } from '../imap-flow.js';

// How long to wait for the server to answer LOGOUT before closing the socket anyway. Without a
// bound of its own, an unanswered LOGOUT kept logout() pending until the socket timeout.
const LOGOUT_TIMEOUT = 10 * 1000;

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
    // close() rejects the pending LOGOUT with NoConnection, which counts as a completed logout
    let timer = setTimeout(() => connection.close(), LOGOUT_TIMEOUT);
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
        clearTimer(timer);
        connection.state = connection.states.LOGOUT;
        if (response && typeof response.next === 'function') {
            response.next();
        }
        connection.close();
    }
}
