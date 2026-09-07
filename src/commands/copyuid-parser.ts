import { expandRange, parseBigIntValue } from '../tools.js';
import type { ImapAttributeList, ImapResponse } from '../handler/types.js';
import type { CopyResponseObject } from '../types.js';

/**
 * Parses COPYUID response code from an IMAP response (RFC 4315).
 * Used by both COPY and MOVE commands to extract the UID mapping
 * from source mailbox to destination mailbox.
 *
 * @param response - IMAP response object with attributes
 * @param map - Result map to populate with uidValidity and uidMap
 */
export function parseCopyUid(response: ImapResponse, map: CopyResponseObject): void {
    let section = response.attributes && response.attributes[0] && response.attributes[0].section;
    let responseCode = section && section.length && section[0] && typeof section[0].value === 'string' ? section[0].value : '';

    if (responseCode !== 'COPYUID') {
        return;
    }

    // A COPYUID code always comes with its section, see responseCode above
    let codeSection = section as ImapAttributeList;

    // Only a bounded pure digit string is accepted: isNaN() also passes values like "1e5" or
    // "Infinity", which BigInt() then rejects with a throw that loses the uidMap.
    let uidValidity = parseBigIntValue(codeSection[1] && codeSection[1].value);
    if (uidValidity !== false) {
        map.uidValidity = uidValidity;
    }

    const sourceUids = codeSection[2] && typeof codeSection[2].value === 'string' ? expandRange(codeSection[2].value) : false;
    const destinationUids = codeSection[3] && typeof codeSection[3].value === 'string' ? expandRange(codeSection[3].value) : false;
    if (sourceUids && destinationUids && sourceUids.length === destinationUids.length) {
        map.uidMap = new Map(sourceUids.map((uid: number, i: number): [number, number] => [uid, destinationUids[i]]));
    }
}
