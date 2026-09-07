import { encodePath, normalizePath, enhanceCommandError, parseUintValue, isUnsafeKey } from '../tools.js';
import type { ImapFlow, ExecResponse } from '../imap-flow.js';
import type { ImapFlowError } from '../errors.js';
import type { ImapResponse } from '../handler/types.js';
import type { QuotaResponse } from '../types.js';

/**
 * Requests quota information for a mailbox.
 *
 * @param connection - IMAP connection instance
 * @param path - Mailbox path to query quota for
 * @returns Quota information object, false if QUOTA not supported or on failure, or undefined if preconditions not met
 */
export default async function quota(connection: ImapFlow, path: string | string[]): Promise<QuotaResponse | false | undefined> {
    if (![connection.states.AUTHENTICATED, connection.states.SELECTED].includes(connection.state) || !path) {
        // nothing to do here
        return;
    }

    if (!connection.capabilities.has('QUOTA')) {
        return false;
    }

    path = normalizePath(connection, path);

    let map: QuotaResponse = { path };

    // Parse a QUOTA response. The resource list uses a repeating triplet pattern (i % 3):
    //   position 0: resource name (e.g., "STORAGE", "MESSAGE")
    //   position 1: current usage
    //   position 2: limit
    // Storage values are in KB on the wire; multiply by 1024 to report bytes.
    let processQuotaResponse = (untagged: ImapResponse): false | undefined => {
        let attributes = untagged.attributes && untagged.attributes[1];
        if (!attributes || !Array.isArray(attributes) || !attributes.length) {
            return false;
        }

        let key: string | false = false;
        attributes.forEach((attribute, i) => {
            const position = i % 3;

            if (position === 0) {
                key = attribute && typeof attribute.value === 'string' ? attribute.value.toLowerCase() : false;
                return;
            }

            if (!key) {
                return;
            }

            // isNaN() also passes '1e5', ' 12 ' and 'Infinity', none of which is a usable octet count
            let value = parseUintValue(attribute && attribute.value);
            if (value === false) {
                return;
            }

            // Resource names are server-controlled. This object is returned to the caller, so it
            // keeps a normal prototype and unsafe names are dropped instead; the fixed fields
            // must keep their values too.
            if (isUnsafeKey(key) || key === 'path' || key === 'quotaroot') {
                return;
            }

            if (!map[key]) {
                map[key] = {};
            }

            // Storage quota is reported in KB by IMAP; convert to bytes for consistency
            const multiplier = key === 'storage' ? 1024 : 1;

            if (position === 1) {
                map[key].usage = value * multiplier;
            } else if (position === 2) {
                map[key].limit = value * multiplier;
                // Calculate usage percentage for convenient display
                if (map[key].limit) {
                    map[key].status = Math.round(((map[key].usage || 0) / map[key].limit) * 100) + '%';
                }
            }
        });
    };

    let quotaFound = false;
    let response: ExecResponse;
    try {
        // Two-step quota lookup: GETQUOTAROOT identifies the quota root for a mailbox,
        // and the server usually sends the QUOTA response inline. Some servers only
        // send the root name and require a separate GETQUOTA command.
        response = await connection.exec('GETQUOTAROOT', [{ type: 'ATOM', value: encodePath(connection, path) }], {
            untagged: {
                // QUOTAROOT response tells us which quota root applies to this mailbox.
                // A mailbox may have zero or one quota root.
                QUOTAROOT: async (untagged: ImapResponse) => {
                    let quotaRoot =
                        untagged.attributes && untagged.attributes[1] && typeof untagged.attributes[1].value === 'string'
                            ? untagged.attributes[1].value
                            : false;
                    if (quotaRoot) {
                        map.quotaRoot = quotaRoot;
                    }
                },
                // QUOTA response provides the actual resource usage and limits
                QUOTA: async (untagged: ImapResponse) => {
                    quotaFound = true;
                    processQuotaResponse(untagged);
                }
            }
        });

        response.next();

        // Fallback: if we got a quota root but no QUOTA response inline,
        // explicitly request quota for that root.
        if (map.quotaRoot && !quotaFound) {
            response = await connection.exec('GETQUOTA', [{ type: 'ATOM', value: map.quotaRoot }], {
                untagged: {
                    QUOTA: async (untagged: ImapResponse) => {
                        processQuotaResponse(untagged);
                    }
                }
            });
            // Release the parser: without this the connection stalls, because the reader loop
            // waits for the response to be handed back before parsing any further input.
            response.next();
        }

        return map;
    } catch (err) {
        await enhanceCommandError(err as ImapFlowError);
        connection.log.warn({ err, cid: connection.id });
        return false;
    }
}
