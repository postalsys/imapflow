import { parseBigIntValue, parseUintValue, getStringValue, MAX_UINT32_DIGITS } from '../tools.js';
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
                const range = (items[0] as ImapAttributeNode | null)?.value;
                if (typeof range !== 'string') break;
                // RFC 9394 partial-results is a sequence-set or NIL, the latter when the requested
                // range lies past the end of the results. NIL is reported as an empty set.
                const messages = (items[1] as ImapAttributeNode | null)?.value;
                result.partial = {
                    range,
                    messages: typeof messages === 'string' ? messages : ''
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

// An RFC 9051 sequence-set, the form an ESEARCH ALL value must take
const RE_SEQUENCE_SET = /^(?:\d+|\*)(?::(?:\d+|\*))?(?:,(?:\d+|\*)(?::(?:\d+|\*))?)*$/;

/**
 * Checks that an ESEARCH response to a search that returns a plain list of numbers can be read
 * as the whole result: the correlator and the UID indicator are well-formed and match the
 * command, every item is an atom followed by a value and appears once, ALL is a sequence-set,
 * and no item stands for something other than the full membership (PARTIAL, or COUNT, MIN or
 * MAX of a nonempty result without ALL). Unknown items and a MODSEQ value are accepted.
 *
 * @param attrs - The attributes of the untagged ESEARCH response
 * @param uid - Whether the command was UID SEARCH
 * @param problems - Collects short fixed reasons the response can not be read as the whole
 *   result, without server text
 * @returns The value of the (TAG "x") correlator, compared with the command tag once it
 *   completed, or undefined when the response has none
 */
export function checkEsearchAnswer(attrs: ImapAttributeList, uid: boolean, problems: Set<string>): string | undefined {
    let correlator: string | undefined;
    let i = 0;
    const first = attrs[0];
    if (Array.isArray(first)) {
        i++;
        const name = first[0] as ImapAttributeNode | null | undefined;
        correlator = getStringValue(first[1]);
        if (first.length !== 2 || name?.type !== 'ATOM' || String(name.value).toUpperCase() !== 'TAG' || correlator === undefined) {
            problems.add('invalid correlator');
            correlator = undefined;
        }
    }
    const indicator = attrs[i] as ImapAttributeNode | null | undefined;
    const hasUid = !!indicator && indicator.type === 'ATOM' && String(indicator.value).toUpperCase() === 'UID';
    if (hasUid) {
        i++;
    }
    if (hasUid !== uid) {
        problems.add('UID indicator mismatch');
    }
    const items = new Map<string, ImapAttributeNode | ImapAttributeList>();
    for (; i < attrs.length; i += 2) {
        const key = attrs[i];
        if (Array.isArray(key) || !key || key.type !== 'ATOM' || typeof key.value !== 'string') {
            problems.add('item name is not an atom');
            return correlator;
        }
        const value = attrs[i + 1];
        if (!value) {
            problems.add('item without a value');
            return correlator;
        }
        const name = key.value.toUpperCase();
        if (items.has(name)) {
            problems.add('repeated item');
        }
        items.set(name, value);
    }
    const all = items.get('ALL');
    if (all && (Array.isArray(all) || typeof all.value !== 'string' || !RE_SEQUENCE_SET.test(all.value))) {
        problems.add('ALL is not a sequence-set');
    }
    if (items.has('PARTIAL')) {
        problems.add('partial result');
    }
    if (!all) {
        const count = items.get('COUNT');
        if ((count && (Array.isArray(count) || count.value !== '0')) || items.has('MIN') || items.has('MAX')) {
            problems.add('result without ALL');
        }
    }
    return correlator;
}
