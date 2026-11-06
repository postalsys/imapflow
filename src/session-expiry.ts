// The `sessionExpires` option: a server that ends a session at a known time whatever the client
// does. Exchange Online ends an IMAP session when the OAuth2 access token it authenticated with
// expires, and answers the first command after that with `BYE Session invalidated -
// AccessTokenExpired`, failing whatever the command was. IMAP has no way to authenticate again
// inside an authenticated session, so the only way around it is a new connection, and the client
// can at least close the old one at a moment when nothing is running on it.

// How long before `sessionExpires` the client starts looking for a free moment to close
export const DEFAULT_SESSION_EXPIRY_LEAD = 5 * 60 * 1000;

// How long before `sessionExpires` the client closes the connection even when it is busy. Capped
// at half the lead, so a short lead still leaves time to find a free moment first
const SESSION_CLOSE_MARGIN = 30 * 1000;

/** When the two session expiry timers fire, in milliseconds from now */
export interface SessionExpiryPlan {
    /** Start closing the connection at its first free moment */
    dueIn: number;
    /** Close the connection whatever it is doing */
    closeIn: number;
}

/**
 * Turns the `sessionExpires` and `sessionExpiryLead` options into timer delays.
 *
 * @param sessionExpires When the server ends the session, a Date or milliseconds since the epoch
 * @param sessionExpiryLead How long before that to start looking for a free moment, in milliseconds
 * @param now Current time in milliseconds since the epoch
 * @returns The delays, or `null` when no usable expiry was given
 */
export function planSessionExpiry(sessionExpires: Date | number | undefined, sessionExpiryLead: number | undefined, now: number): SessionExpiryPlan | null {
    if (sessionExpires === undefined || sessionExpires === null) {
        return null;
    }
    const expiresAt = sessionExpires instanceof Date ? sessionExpires.getTime() : Number(sessionExpires);
    if (!Number.isFinite(expiresAt)) {
        return null;
    }

    const lead =
        typeof sessionExpiryLead === 'number' && Number.isFinite(sessionExpiryLead) && sessionExpiryLead >= 0 ? sessionExpiryLead : DEFAULT_SESSION_EXPIRY_LEAD;
    const margin = Math.min(SESSION_CLOSE_MARGIN, lead / 2);

    return {
        dueIn: Math.max(0, expiresAt - lead - now),
        closeIn: Math.max(0, expiresAt - margin - now)
    };
}
