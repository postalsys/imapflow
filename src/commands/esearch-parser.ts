import { parseBigIntValue, parseUintValue, MAX_UINT32_DIGITS } from '../tools.js';
import type { ImapAttributeList, ImapAttributeNode } from '../handler/types.js';
import type { ESearchResult } from '../types.js';

/**
 * Parses the key-value attributes from an ESEARCH untagged response.
 *
 * Receives the attribute list AFTER stripping the leading (TAG "X") list
 * and the UID atom, i.e. only the result keyword/value pairs remain.
 *
 * ALL and PARTIAL.messages are kept as compact sequence-set strings.
 * Use expandRange() from tools.ts if you need to expand them.
 * MODSEQ (RFC 7162, sent when the search used a MODSEQ criterion) is
 * returned as a BigInt.
 *
 * @param attrs - Attribute array from the IMAP parser
 * @returns ESearchResult object
 */
export function parseEsearchResponse(attrs: ImapAttributeList): ESearchResult {
    const result: ESearchResult = {};
    let i = 0;
    while (i < attrs.length) {
        const token = attrs[i];
        if (!token || token.type !== 'ATOM') {
            i++;
            continue;
        }
        const key = (token.value as string).toUpperCase();
        if (i + 1 >= attrs.length) {
            i++;
            continue;
        }
        switch (key) {
            // COUNT is a plain message count; MIN and MAX are sequence numbers or UIDs. All
            // three are bounded decimal runs - isNaN() would also admit '1e400' (Infinity)
            case 'COUNT': {
                const n = parseUintValue(attrs[++i]?.value, MAX_UINT32_DIGITS);
                if (n !== false) result.count = n;
                break;
            }
            case 'MIN': {
                const n = parseUintValue(attrs[++i]?.value, MAX_UINT32_DIGITS);
                if (n !== false) result.min = n;
                break;
            }
            case 'MAX': {
                const n = parseUintValue(attrs[++i]?.value, MAX_UINT32_DIGITS);
                if (n !== false) result.max = n;
                break;
            }
            case 'MODSEQ': {
                // RFC 7162 section 3.1.5: present when the SEARCH used a MODSEQ
                // criterion on a CONDSTORE-enabled session. BigInt because
                // mod-sequence values are unsigned 63-bit
                const modseq = parseBigIntValue(attrs[++i]?.value);
                if (modseq !== false) result.modseq = modseq;
                break;
            }
            case 'ALL': {
                const allToken = attrs[++i];
                if (allToken && typeof allToken.value === 'string') {
                    result.all = allToken.value;
                }
                break;
            }
            case 'PARTIAL': {
                const listToken = attrs[++i];
                const items = Array.isArray(listToken) ? listToken : null;
                if (!items || items.length < 2) break;
                result.partial = {
                    range: (items[0] as ImapAttributeNode).value as string,
                    messages: (items[1] as ImapAttributeNode).value as string
                };
                break;
            }
            default:
                // Skip the value token for unknown keys to keep the stream aligned.
                // The loop's unconditional i++ at the bottom advances past the key;
                // this extra i++ advances past the value token.
                i++;
                break;
        }
        i++;
    }
    return result;
}
