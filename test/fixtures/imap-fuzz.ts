// Seeded generators for the protocol fuzz suites. Every generated server response comes with the
// structure the parser must produce for it (the model), so a suite can check the parse result
// against what was generated instead of only checking that parsing did not throw.
//
// The runs are reproducible: FUZZ_SEED picks the seed and FUZZ_ITERATIONS the number of cases,
// so a failure reported for one seed reruns as `FUZZ_SEED=<seed> FUZZ_ITERATIONS=1`.

import type { ImapAttribute, ImapResponse } from '../../src/handler/types.js';

export const FUZZ_SEED = Number(process.env.FUZZ_SEED) || 20261006;
export const FUZZ_ITERATIONS = Number(process.env.FUZZ_ITERATIONS) || 300;

/**
 * mulberry32, a small seeded PRNG. Not for anything but reproducible test input.
 */
export class Rng {
    state: number;

    constructor(seed: number) {
        this.state = seed >>> 0; // eslint-disable-line no-bitwise
    }

    next(): number {
        /* eslint-disable no-bitwise */
        let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        /* eslint-enable no-bitwise */
    }

    /** Integer in [min, max], both inclusive */
    int(min: number, max: number): number {
        return min + Math.floor(this.next() * (max - min + 1));
    }

    chance(p: number): boolean {
        return this.next() < p;
    }

    pick<T>(list: readonly T[]): T {
        return list[this.int(0, list.length - 1)]!;
    }

    bytes(length: number): Buffer {
        let buf = Buffer.alloc(length);
        for (let i = 0; i < length; i++) {
            buf[i] = this.int(0, 255);
        }
        return buf;
    }

    /** A string of `length` characters drawn from `alphabet` */
    string(alphabet: string, length: number): string {
        // by code point, so a surrogate pair is never split
        let chars = Array.from(alphabet);
        let out = '';
        for (let i = 0; i < length; i++) {
            out += this.pick(chars);
        }
        return out;
    }
}

/**
 * A generated server response: the bytes a server sends (literal bodies inline, no trailing
 * CRLF) and the parse result they must produce
 */
export interface GeneratedResponse {
    wire: Buffer;
    expected: ImapResponse;
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const ATOM_REST = LETTERS + DIGITS + '-_.$';
// Printable ASCII plus a few multi-byte characters. The parser decodes the line as UTF-8, so a
// quoted string carrying them must come back unchanged
const STRING_CHARS = ' !#%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvwxyz{|}~"\\\u00e9\u00fc\u4e2d\u{1f600}';
const TEXT_CHARS = LETTERS + DIGITS + ' .,:;!?-_()]';
const RESPONSE_CODES = ['UIDNEXT', 'UIDVALIDITY', 'HIGHESTMODSEQ', 'PERMANENTFLAGS', 'COPYUID', 'APPENDUID', 'CAPABILITY', 'READ-WRITE', 'ALERT', 'X-CUSTOM'];
const COMMANDS = ['CAPABILITY', 'LIST', 'LSUB', 'SEARCH', 'STATUS', 'FLAGS', 'ESEARCH', 'NAMESPACE', 'ID', 'QUOTA', 'ENABLED', 'X-UNKNOWN'];

interface Part {
    // wire bytes of the token, literal bodies inline
    wire: Buffer[];
    value: ImapAttribute;
}

const ascii = (str: string): Buffer => Buffer.from(str, 'latin1');

// A parenthesized list: "(" items separated by single spaces ")"
const listPart = (items: Part[]): Part => {
    let wire: Buffer[] = [ascii('(')];
    items.forEach((item, i) => {
        if (i) {
            wire.push(ascii(' '));
        }
        wire.push(...item.wire);
    });
    wire.push(ascii(')'));
    return { wire, value: items.map(item => item.value) };
};

const atomValue = (rng: Rng): string => {
    let value = (rng.chance(0.6) ? rng.string(LETTERS, 1) : rng.pick(['\\', '$'])) + rng.string(ATOM_REST, rng.int(0, 12));
    // NIL in any letter case is the null token, not an atom
    return value.toUpperCase() === 'NIL' ? value + 'X' : value;
};

// A token that starts like a sequence set but is not one ("2024:Q1", "1,a", "10:", "1::2"). ":" and
// "," are ATOM-CHARs, so servers send such mailbox names and keywords unquoted, and they parse as
// atoms
const digitLedAtomValue = (rng: Rng): string => {
    let head = rng.string(DIGITS, rng.int(1, 5)) + rng.pick([':', ',']);
    switch (rng.int(0, 2)) {
        case 0:
            return head + rng.string(LETTERS, 1) + rng.string(ATOM_REST, rng.int(0, 8));
        case 1:
            return head;
        default:
            return head + rng.pick([':', ',']) + rng.string(DIGITS, rng.int(0, 3));
    }
};

const numberValue = (rng: Rng): string => String(rng.int(0, 1) ? rng.int(0, 99) : rng.int(0, 4294967295));

const seqNumber = (rng: Rng): string => String(rng.int(1, 99999));

// The response parser takes "*" only as the end of a range ("5:*"), a bare "*" element is
// rejected (E30, E32). Servers send resolved numbers, so the generator stays inside that grammar
const sequenceValue = (rng: Rng): string => {
    let parts: string[] = [];
    let count = rng.int(1, 4);
    for (let i = 0; i < count; i++) {
        parts.push(rng.chance(0.6) ? `${seqNumber(rng)}:${rng.chance(0.2) ? '*' : seqNumber(rng)}` : seqNumber(rng));
    }
    // a single bare number is an ATOM, a sequence needs a range or a list
    if (parts.length === 1 && !parts[0]!.includes(':')) {
        parts.push(seqNumber(rng));
    }
    return parts.join(',');
};

const quoted = (value: string): string => '"' + value.replace(/["\\]/g, c => '\\' + c) + '"';

const genSection = (rng: Rng): Part => {
    let wire: Buffer[] = [];
    let section: ImapAttribute[] = [];
    let kind = rng.int(0, 3);
    let inner = '';
    if (kind === 1) {
        let spec = rng.pick(['HEADER', 'TEXT', 'MIME', '1', '1.2', '2.HEADER', '1.2.3.TEXT']);
        inner = spec;
        section.push({ type: 'ATOM', value: spec });
    } else if (kind >= 2) {
        let spec = rng.pick(['HEADER.FIELDS', 'HEADER.FIELDS.NOT', '1.HEADER.FIELDS']);
        let fields: ImapAttribute[] = [];
        let names: string[] = [];
        let count = rng.int(1, 4);
        for (let i = 0; i < count; i++) {
            let name = rng.pick(['FROM', 'TO', 'SUBJECT', 'DATE', 'MESSAGE-ID', 'X-' + rng.string(LETTERS, 3)]);
            names.push(name);
            fields.push({ type: 'ATOM', value: name });
        }
        inner = `${spec} (${names.join(' ')})`;
        section.push({ type: 'ATOM', value: spec }, fields);
    }
    let name = rng.pick(['BODY', 'BINARY', 'BODY.PEEK']);
    wire.push(ascii(`${name}[${inner}]`));
    let value: ImapAttribute = { type: 'ATOM', value: name, section: section as any };
    if (rng.chance(0.4)) {
        let start = rng.int(0, 1) ? 0 : rng.int(1, 100000);
        if (rng.chance(0.5)) {
            let length = rng.int(1, 100000);
            wire.push(ascii(`<${start}.${length}>`));
            value.partial = [start, length];
        } else {
            wire.push(ascii(`<${start}>`));
            value.partial = [start];
        }
    }
    return { wire, value };
};

const genLiteral = (rng: Rng): Part => {
    // biased toward the bytes that matter to framing: CR, LF, braces, NUL, high bit
    let length = rng.chance(0.1) ? 0 : rng.int(1, 64);
    let body = Buffer.alloc(length);
    for (let i = 0; i < length; i++) {
        body[i] = rng.chance(0.3) ? rng.pick([0x0d, 0x0a, 0x7b, 0x7d, 0x00, 0x22, 0x5c, 0x20, 0xff]) : rng.int(0, 255);
    }
    let literal8 = rng.chance(0.15);
    return {
        wire: [ascii(`${literal8 ? '~' : ''}{${length}}\r\n`), body],
        value: { type: 'LITERAL', value: body }
    };
};

const genAttribute = (rng: Rng, depth: number): Part => {
    let kind = rng.int(0, depth < 4 ? 9 : 7);
    switch (kind) {
        case 0:
        case 1: {
            let value = rng.chance(0.25) ? digitLedAtomValue(rng) : atomValue(rng);
            return { wire: [ascii(value)], value: { type: 'ATOM', value } };
        }
        case 2: {
            let value = numberValue(rng);
            return { wire: [ascii(value)], value: { type: 'ATOM', value } };
        }
        case 3: {
            let value = sequenceValue(rng);
            return { wire: [ascii(value)], value: { type: 'SEQUENCE', value } };
        }
        case 4: {
            let value = rng.string(STRING_CHARS, rng.int(0, 20));
            return { wire: [Buffer.from(quoted(value))], value: { type: 'STRING', value } };
        }
        case 5:
            return genLiteral(rng);
        case 6:
            return { wire: [ascii(rng.pick(['NIL', 'nil', 'Nil']))], value: null };
        case 7:
            return genSection(rng);
        default: {
            let children: Part[] = [];
            let count = rng.int(0, 5);
            for (let i = 0; i < count; i++) {
                children.push(genAttribute(rng, depth + 1));
            }
            return listPart(children);
        }
    }
};

/**
 * Generates one server response. Status responses (OK, NO, BAD, BYE, PREAUTH) carry an optional
 * response code and human-readable text; everything else is a tagged or untagged data response
 * with an attribute list.
 */
export const generateResponse = (rng: Rng): GeneratedResponse => {
    let tag = rng.chance(0.7) ? '*' : rng.pick(['A', 'B', 'X']) + rng.int(1, 9999);

    if (rng.chance(0.3)) {
        let command = rng.pick(tag === '*' ? ['OK', 'NO', 'BAD', 'BYE', 'PREAUTH'] : ['OK', 'NO', 'BAD']);
        let attributes: ImapAttribute[] = [];
        let line = `${tag} ${command}`;
        if (rng.chance(0.6)) {
            let code = rng.pick(RESPONSE_CODES);
            let args: ImapAttribute[] = [{ type: 'ATOM', value: code }];
            let argWire = '';
            let count = rng.int(0, 2);
            for (let i = 0; i < count; i++) {
                let value = numberValue(rng);
                argWire += ' ' + value;
                args.push({ type: 'ATOM', value });
            }
            line += ` [${code}${argWire}]`;
            attributes.push({ type: 'ATOM', value: '', section: args as any });
        }
        // text never starts with "[" (that would be a response code) and is trimmed by the parser
        let text = rng.string(TEXT_CHARS, rng.int(0, 30)).trim();
        if (text) {
            line += ' ' + text;
            attributes.push({ type: 'TEXT', value: text });
        }
        let expected: ImapResponse = { tag, command };
        if (attributes.length) {
            expected.attributes = attributes as any;
        }
        return { wire: ascii(line), expected };
    }

    let command: string;
    let parts: Part[] = [];
    if (tag === '*' && rng.chance(0.5)) {
        // "* 12 FETCH (...)", "* 3 EXISTS": the message number is the command
        command = String(rng.int(1, 99999));
        if (rng.chance(0.3)) {
            let name = rng.pick(['EXISTS', 'EXPUNGE', 'RECENT']);
            parts.push({ wire: [ascii(name)], value: { type: 'ATOM', value: name } });
        } else {
            parts.push({ wire: [ascii('FETCH')], value: { type: 'ATOM', value: 'FETCH' } });
            let items: Part[] = [];
            let count = rng.int(1, 6);
            for (let i = 0; i < count; i++) {
                items.push(rng.chance(0.3) ? genSection(rng) : genAttribute(rng, 1));
            }
            parts.push(listPart(items));
        }
    } else {
        command = rng.pick(COMMANDS);
        let count = rng.int(0, 6);
        for (let i = 0; i < count; i++) {
            parts.push(genAttribute(rng, 0));
        }
    }

    let wire = Buffer.concat([ascii(`${tag} ${command}`), ...parts.flatMap(part => [ascii(' '), ...part.wire])]);
    let expected: ImapResponse = { tag, command };
    if (parts.length) {
        expected.attributes = parts.map(part => part.value) as any;
    }
    return { wire, expected };
};

/**
 * Corrupts a response the way broken servers and hostile input do: flipped, dropped, duplicated
 * and inserted bytes, stray line breaks and literal markers, truncation, deep nesting
 */
export const mutate = (rng: Rng, input: Buffer): Buffer => {
    let buf = Buffer.from(input);
    let count = rng.int(1, 4);
    for (let n = 0; n < count; n++) {
        let pos = buf.length ? rng.int(0, buf.length - 1) : 0;
        let insert = (data: Buffer | string) => {
            buf = Buffer.concat([buf.subarray(0, pos), Buffer.isBuffer(data) ? data : ascii(data), buf.subarray(pos)]);
        };
        switch (rng.int(0, 11)) {
            case 0:
                if (buf.length) {
                    buf[pos] = rng.int(0, 255);
                }
                break;
            case 1:
                buf = Buffer.concat([buf.subarray(0, pos), buf.subarray(pos + rng.int(1, 8))]);
                break;
            case 2:
                insert(buf.subarray(pos, pos + rng.int(1, 16)));
                break;
            case 3:
                insert(rng.pick(['\r\n', '\n', '\r', '\0', '\0\0']));
                break;
            case 4:
                insert(`{${rng.pick(['0', '1', '5', '99', '4294967296', '010', '99999999999999999999', ''])}}\r\n`);
                break;
            case 5:
                insert(rng.pick(['(', ')', '[', ']', '<', '>', '"', '\\', '{', '}', '~', '+', ' ', '  ']));
                break;
            case 6:
                buf = buf.subarray(0, pos);
                break;
            case 7:
                insert('('.repeat(rng.int(1, 300)));
                break;
            case 8:
                insert(rng.pick(['BODY[', 'BODY[]<', '<0.', '[UIDNEXT', '* ', 'NIL', '~{']));
                break;
            case 9:
                insert(rng.bytes(rng.int(1, 16)));
                break;
            case 10:
                insert('\r\n' + rng.pick(['* ', '+ ', 'A1 OK ', '', ')'] as const));
                break;
            default:
                insert(rng.pick(['1:', ',', ':*', '*:', '.', '0', '-1']));
        }
    }
    return buf;
};

/**
 * Cuts a buffer into chunks. The strategies cover the boundaries that matter to a streaming
 * parser: random cuts, single bytes, and a cut at every CR, LF and brace.
 */
export const split = (rng: Rng, buf: Buffer): Buffer[] => {
    let strategy = rng.int(0, 3);
    let cuts = new Set<number>();
    if (strategy === 0) {
        for (let i = 1; i < buf.length; i++) {
            cuts.add(i);
        }
    } else if (strategy === 1) {
        for (let i = 1; i < buf.length; i++) {
            if ([0x0d, 0x0a, 0x7b, 0x7d].includes(buf[i]!)) {
                cuts.add(i);
                cuts.add(i + 1);
            }
        }
    } else {
        let count = rng.int(1, 12);
        for (let i = 0; i < count; i++) {
            cuts.add(rng.int(1, Math.max(1, buf.length - 1)));
        }
    }
    let chunks: Buffer[] = [];
    let last = 0;
    for (let cut of [...cuts].filter(c => c > 0 && c < buf.length).sort((a, b) => a - b)) {
        chunks.push(buf.subarray(last, cut));
        last = cut;
    }
    chunks.push(buf.subarray(last));
    return chunks;
};
