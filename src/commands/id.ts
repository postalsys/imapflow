import { formatDateTime } from '../tools.js';
import type { ImapFlow, ExecResponse } from '../imap-flow.js';
import type { ImapAttribute, ImapAttributeNode, ImapResponse } from '../handler/types.js';
import type { IdInfoObject } from '../types.js';

/**
 * Sends ID info to the server and updates server info data based on the response.
 *
 * @param connection - IMAP connection instance
 * @param clientInfo - Client identification key-value pairs to send to the server
 * @returns Server information map, false on failure, or undefined if ID not supported
 */
// RFC 2971: The ID command exchanges client/server implementation info
// (name, version, vendor, etc.) for diagnostic and compatibility purposes.
export default async function id(connection: ImapFlow, clientInfo?: IdInfoObject | null | undefined): Promise<IdInfoObject | false | undefined> {
    if (!connection.capabilities.has('ID')) {
        // nothing to do here
        return;
    }

    let response: ExecResponse;
    try {
        let map: IdInfoObject = {};

        // Convert the clientInfo object into a flat array of alternating key-value strings
        // for the IMAP wire format: ("key1" "value1" "key2" "value2" ...)
        let formattedClientInfo: (string | undefined)[] | null = !clientInfo
            ? null
            : Object.keys(clientInfo)
                  .map(key => [key, formatValue(key, clientInfo[key])])
                  .filter(entry => entry[1])
                  .flatMap(entry => entry);

        if (formattedClientInfo && !formattedClientInfo.length) {
            // value array has no elements
            formattedClientInfo = null;
        }

        response = await connection.exec('ID', [formattedClientInfo], {
            untagged: {
                // Parse the server's ID response: a flat list of alternating key-value atoms.
                // Even indices (i % 2 === 0) are keys, odd indices are the corresponding values.
                ID: async (untagged: ImapResponse) => {
                    let params = untagged.attributes && untagged.attributes[0];
                    let key: string | Buffer | number | null | undefined;
                    (Array.isArray(params) ? params : ([] as ImapAttribute[]).concat(params || [])).forEach((val, i) => {
                        if (i % 2 === 0) {
                            key = (val as ImapAttributeNode).value;
                        } else if (typeof key === 'string' && typeof (val as ImapAttributeNode).value === 'string') {
                            map[key.toLowerCase().trim()] = (val as ImapAttributeNode).value;
                        }
                    });
                }
            }
        });
        connection.serverInfo = map;
        response.next();
        return map;
    } catch (err) {
        connection.log.warn({ err, cid: connection.id });
        return false;
    }
}

/**
 * Formats a client info value for the ID command.
 *
 * @param key - The info key name
 * @param value - The value to format
 * @returns Formatted value string
 */
function formatValue(key: string, value: any): string | undefined {
    switch (key.toLowerCase()) {
        case 'date':
            // RFC 2971 requires the "date" field to use IMAP date-time format
            // (e.g., "06-Feb-2026 12:00:00 +0000"), not ISO 8601 or other formats.
            return formatDateTime(value);
        default:
            // Other values are strings without newlines
            return (value || '').toString().replace(/\s+/g, ' ');
    }
}
