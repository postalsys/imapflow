import { expandRange, parseBigIntValue } from '../tools.js';
import type { ImapAttribute, ImapAttributeList, ImapResponse } from '../handler/types.js';
import type { CopyResponseObject } from '../types.js';

/**
 * Whether a value is a complete uid-set (RFC 4315): comma separated UIDs and UID ranges. The UID
 * map pairs the source and destination sets by position, so a set with a malformed element must
 * be refused as a whole: skipping the element, as expandRange() does, would shift every UID after
 * it onto the wrong counterpart. Checked per element, as a whole-set regex with an unbounded
 * repeat can overflow the regex engine on very long sets.
 */
const UID_SET_ELEMENT = /^\d+(:\d+)?$/;
const isUidSet = (value: unknown): value is string => typeof value === 'string' && value.split(',').every(part => UID_SET_ELEMENT.test(part));

// The UIDs of a uid-set attribute, or false when the attribute is not a complete uid-set
const uidSetValues = (attribute: ImapAttribute | undefined): number[] | false => {
    const value = attribute && attribute.value;
    return isUidSet(value) ? expandRange(value) : false;
};

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

    const sourceUids = uidSetValues(codeSection[2]);
    const destinationUids = uidSetValues(codeSection[3]);
    if (sourceUids && destinationUids && sourceUids.length === destinationUids.length) {
        map.uidMap = new Map(sourceUids.map((uid: number, i: number): [number, number] => [uid, destinationUids[i]]));
    }
}
