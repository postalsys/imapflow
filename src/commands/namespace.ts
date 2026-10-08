import { hasCapability, getStringList, getStringValue, isAuthenticatedState } from '../tools.js';
import type { ImapFlow, ExecResponse } from '../imap-flow.js';
import type { ImapAttribute, ImapResponse } from '../handler/types.js';
import type { NamespaceObject, NamespacesObject } from '../types.js';

/**
 * Returned instead of a namespace when the NAMESPACE command failed
 */
export interface NamespaceErrorResult {
    error: true;
    status: string | undefined;
    text: string | undefined;
}

/**
 * Prefix and delimiter derived from `LIST "" ""`
 */
export interface ListPrefixInfo {
    flags?: Set<string> | undefined;
    delimiter?: string | null | undefined;
    prefix?: string | undefined;
}

/**
 * Requests NAMESPACE info from the server.
 *
 * @param connection - IMAP connection instance
 * @returns The primary personal namespace, or an error object on failure
 */
export default async function namespace(connection: ImapFlow): Promise<NamespaceObject | NamespaceErrorResult | undefined> {
    if (!isAuthenticatedState(connection)) {
        // nothing to do here
        return;
    }

    if (!hasCapability(connection, 'NAMESPACE')) {
        // Fallback: when the server does not support the NAMESPACE extension (RFC 2342),
        // derive the prefix and delimiter from a LIST "" "" command, which returns
        // the hierarchy delimiter and root name for the default mailbox hierarchy.
        let { prefix, delimiter } = await getListPrefix(connection);
        // Ensure the prefix ends with the delimiter so that appending a mailbox name
        // produces a valid path (e.g., "INBOX." + "Sent" = "INBOX.Sent").
        if (delimiter && prefix && prefix.charAt(prefix.length - 1) !== delimiter) {
            prefix += delimiter;
        }
        let map: NamespacesObject = {
            personal: [{ prefix: prefix || '', delimiter }],
            other: false,
            shared: false
        };
        connection.namespaces = map;
        connection.namespace = connection.namespaces.personal[0];
        return connection.namespace;
    }

    let response: ExecResponse;
    try {
        // NIL personal namespaces and a missing NAMESPACE response leave the defaults in place
        let map: NamespacesObject = { personal: [], other: false, shared: false };
        response = await connection.exec('NAMESPACE', false, {
            untagged: {
                // The NAMESPACE response (RFC 2342) contains exactly three sections:
                //   [0] = personal namespaces (user's own mailboxes)
                //   [1] = other users' namespaces (shared by other users)
                //   [2] = shared namespaces (public/organizational folders)
                // Each section is either NIL or a list of (prefix, delimiter) pairs.
                NAMESPACE: async (untagged: ImapResponse) => {
                    if (!untagged.attributes || !untagged.attributes.length) {
                        return;
                    }
                    // NIL personal namespaces are legal (RFC 2342 section 5, e.g. after an anonymous login)
                    map.personal = getNamsepaceInfo(untagged.attributes[0]) || [];
                    map.other = getNamsepaceInfo(untagged.attributes[1]);
                    map.shared = getNamsepaceInfo(untagged.attributes[2]);
                }
            }
        });
        // Release the response before touching the parsed data, so nothing below can leave the
        // reader parked behind this command
        response.next();

        connection.namespaces = map;

        // make sure that we have the first personal namespace always set
        if (!connection.namespaces.personal[0]) {
            connection.namespaces.personal[0] = { prefix: '', delimiter: '.' };
        }
        connection.namespaces.personal[0].prefix = connection.namespaces.personal[0].prefix || '';

        connection.namespace = connection.namespaces.personal[0];

        return connection.namespace;
    } catch (err: any) {
        connection.log.warn({ err, cid: connection.id });
        return {
            error: true,
            status: err.responseStatus,
            text: err.responseText
        };
    }
}

/**
 * Derives namespace prefix and delimiter from a LIST command when NAMESPACE is not supported.
 *
 * @param connection - IMAP connection instance
 * @returns Object with prefix, delimiter, and flags, or empty object on failure
 */
async function getListPrefix(connection: ImapFlow): Promise<ListPrefixInfo> {
    let response: ExecResponse;
    try {
        let map: ListPrefixInfo = {};
        // LIST "" "" is a special form that returns only the hierarchy delimiter
        // and the root name, without listing any actual mailboxes.
        response = await connection.exec('LIST', ['', ''], {
            untagged: {
                LIST: async (untagged: ImapResponse) => {
                    if (!untagged.attributes || !untagged.attributes.length) {
                        return;
                    }

                    map.flags = new Set(getStringList(untagged.attributes[0]));
                    // the name may be a literal, which arrives as a Buffer
                    map.delimiter = getStringValue(untagged.attributes[1]) || null;
                    map.prefix = getStringValue(untagged.attributes[2]) || '';
                    if (map.delimiter && map.prefix.charAt(0) === map.delimiter) {
                        map.prefix = map.prefix.slice(1);
                    }
                }
            }
        });
        response.next();
        return map;
    } catch (err) {
        connection.log.warn({ err, cid: connection.id });
        return {};
    }
}

/**
 * Parses namespace information from an IMAP NAMESPACE response attribute.
 *
 * @param attribute - Namespace attribute array from the server response
 * @returns Array of namespace entries, or false if empty
 */
function getNamsepaceInfo(attribute: ImapAttribute | undefined): NamespaceObject[] | false {
    if (!attribute || !Array.isArray(attribute) || !attribute.length) {
        return false;
    }

    let entries: NamespaceObject[] = [];
    for (let entry of attribute) {
        if (!Array.isArray(entry)) {
            continue;
        }
        let pair = entry;
        let prefix = getStringValue(pair[0]);
        // RFC 2342 section 5 allows the delimiter to be NIL when the namespace has no hierarchy.
        // The token parser emits a literal `null` for NIL.
        let delimiter = pair[1] === null ? null : getStringValue(pair[1]);
        if (pair.length < 2 || prefix === undefined || delimiter === undefined) {
            continue;
        }

        // Append the delimiter to the prefix if it doesn't already end with one,
        // so callers can construct full paths by simply concatenating prefix + name.
        if (delimiter && prefix && prefix.charAt(prefix.length - 1) !== delimiter) {
            prefix += delimiter;
        }
        entries.push({ prefix, delimiter });
    }
    return entries;
}
