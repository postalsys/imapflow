import { setSubscription } from './subscription.js';
import type { ImapFlow } from '../imap-flow.js';

/**
 * Subscribes to a mailbox.
 *
 * @param connection - IMAP connection instance
 * @param path - Mailbox path to subscribe to
 * @returns True on success, false on failure, or undefined if preconditions not met
 */
export default async function subscribe(connection: ImapFlow, path: string | string[]): Promise<boolean | undefined> {
    return await setSubscription(connection, 'SUBSCRIBE', path);
}
