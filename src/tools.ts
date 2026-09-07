/* eslint no-control-regex:0 */

import libmime from 'libmime';
import { resolveCharset } from './charsets.js';
import { compiler } from './handler/imap-handler.js';
import { createHash } from 'node:crypto';
import { JPDecoder } from './jp-decoder.js';
import iconv from 'iconv-lite';
import type { Transform } from 'node:stream';
import type { ImapFlow } from './imap-flow.js';
import type { ConnectionErrorSite, ImapFlowError } from './errors.js';
import type { ImapAttribute, ImapAttributeList, ImapAttributeNode, ImapCompileInput, ImapResponse } from './handler/types.js';
import type {
    FetchMessageObject,
    ListResponse,
    ListTreeResponse,
    MailboxObject,
    MessageAddressObject,
    MessageEnvelopeObject,
    MessageStructureObject,
    StatusQuery
} from './types.js';

export { AuthenticationFailure } from './errors.js';

const FLAG_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'grey'];

// Error codes that only mean the connection is no longer usable. See logConnectionError().
const CONNECTION_GONE_CODES = new Set(['NoConnection', 'EConnectionClosed', 'StateLogout']);

// Upper bound for expanding server-supplied sequence ranges (see expandRange). 2^24
// entries in total is far beyond any legitimate mailbox while keeping the worst-case
// expansion of a hostile range set bounded.
//
// Shared bound for expanding server-supplied sequence sets. Exported so other places that
// expand server sequences (e.g. ESEARCH ALL in commands/search.ts) can apply the same absolute
// ceiling instead of inventing their own.
export const EXPANDED_RANGE_LIMIT = 0x1000000;

// Digit bounds for untrusted numeric values in server responses. UIDs, UIDVALIDITY and
// message counts are 32-bit unsigned (nz-number in the RFC 9051 grammar, so at most 10
// digits); MODSEQ and number64 values are 63-bit unsigned (RFC 7162, RFC 9051), at most
// 19 digits. The bound is checked before BigInt()/Number(): a response line may carry up
// to maxLineLength digits, and BigInt() on a multi-megabyte digit run costs hundreds of
// milliseconds of non-yielding CPU.
//
// MAX_UINT32_DIGITS is exported so call sites can ask for the tighter 32-bit bound where the
// grammar requires it (UID, UIDVALIDITY, message counts) instead of the parsers' 63-bit default.
export const MAX_UINT32_DIGITS = 10;
const MAX_NUMBER64_DIGITS = 19;

// Object keys that reach through the prototype chain when assigned to, or resolve to an
// inherited member when read. Server-controlled strings become keys in several places
// (STATUS items, QUOTA resources, BODYSTRUCTURE parameters, FETCH body part names), so they
// all consult this one set rather than each carrying its own list.
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Extensions that RFC 9051 (IMAP4rev2) folds into the base protocol (Appendix E).
// When IMAP4rev2 is active, these are available even without their own capability
// token. BINARY is deliberately excluded - RFC 9051 only folds in the FETCH side,
// which fetch.ts handles with its own isRev2Active check, while the APPEND side
// stays gated on the BINARY token. SPECIAL-USE is a partial fold: Appendix E only
// folds in the special-use mailbox attributes, not the RFC 6154 LIST selection and
// RETURN options - the only call sites that act on this entry are in list.ts,
// where a staged retry ladder recovers if a rev2-only server rejects the RETURN
// option. The set mirrors the rest of the Appendix E list in full, including
// entries no call site consults yet, so any future capability check gets the
// rev2 folding for free.
const IMAP4REV2_FOLDED_CAPABILITIES = new Set([
    'ENABLE',
    'ESEARCH',
    'IDLE',
    'LIST-EXTENDED',
    'LIST-STATUS',
    'LITERAL-',
    'MOVE',
    'NAMESPACE',
    'SASL-IR',
    'SEARCHRES',
    'SPECIAL-USE',
    'STATUS=SIZE',
    'UIDPLUS',
    'UNSELECT'
]);

// Deliberate no-op, used as the observer a guarded promise attaches to its own rejection.
export const noop = (): void => {};

// The fields buildConnectionError() stamps to say *where* a connection error was rejected, as
// opposed to what went wrong. restampConnectionError() clears them, because they belong to the
// site that built the error rather than to the failure it describes.
const CONNECTION_ERROR_SITE_KEYS = ['rejectedFrom', 'command', 'path'] as const;

/**
 * A stream decoder returned by getDecoder(). The Japanese decoder reports the `limited`
 * flag once it has buffered all it will accept; a streaming iconv decoder never sets it.
 */
export type CharsetDecoder = Transform & { limited?: boolean | undefined };

/**
 * The value of a string-like ENVELOPE or FETCH token: the string itself, or false when the
 * token is missing
 */
type TokenStringValue = string | number | false | null | undefined;

/**
 * A message object under construction: `seq` and `uid` are filled in from the response and may
 * be missing until the end
 */
type MessageMap = Omit<FetchMessageObject, 'seq' | 'uid'> & { seq?: number | undefined; uid?: number | undefined };

/**
 * Builds an error describing a connection that is gone, stamped so it can be traced back to
 * where it came from: the connection id always travels on it, and each site names itself
 * through `meta` (`rejectedFrom`, plus the command or mailbox path it belongs to).
 *
 * A stack trace only records where an error was built, and close() hands a rejection to every
 * pending request and every queued lock in the same tick, so without these an error that
 * reaches a global unhandledRejection handler arrives with nothing that identifies the
 * connection it came from, let alone which of the rejected promises carried it.
 *
 * Takes the connection id rather than the connection, so the stamping stays in one place
 * without every caller having to be a full ImapFlow instance.
 *
 * @param cid - Connection id
 * @param code - Error code, e.g. 'NoConnection'
 * @param message - Error message
 * @param meta - Fields to stamp on the error
 * @returns The stamped error
 */
export function buildConnectionError(cid: string, code: string, message: string, meta?: ConnectionErrorSite | undefined): ImapFlowError {
    const error: ImapFlowError = new Error(message);
    error.code = code;
    error.cid = cid;
    if (meta) {
        Object.assign(error, meta);
    }
    return error;
}

/**
 * Re-stamps an existing connection error for a different rejection site.
 *
 * The same failure can be handed to more than one promise - close() rejects the in-flight
 * command, and runIdle() then rejects everything queued behind it - and each of those is a
 * separate promise with a separate consumer. Sharing one error object reports whichever of
 * them escapes under the first site's marker, which is the attribution these markers exist to
 * give.
 *
 * Everything describing *what went wrong* is carried over, because a re-stamped error reaches
 * user code through run() and callers branch on `responseStatus`, `serverResponseCode` and
 * friends. Everything describing *where it was rejected* is dropped, because the new site owns
 * those and a leftover `command` from the previous site is exactly as misleading as a leftover
 * `rejectedFrom`. The original travels on as `cause`.
 *
 * @param err - The error being re-stamped
 * @param meta - Fields for the new site, e.g. { rejectedFrom: 'preCheckWaiter' }
 * @returns A separate error describing the same failure at the new site
 */
export function restampConnectionError(err: ImapFlowError, meta?: ConnectionErrorSite | undefined): ImapFlowError {
    let error = buildConnectionError(err.cid as string, err.code as string, err.message, err);
    for (let key of CONNECTION_ERROR_SITE_KEYS) {
        delete error[key];
    }
    if (meta) {
        Object.assign(error, meta);
    }
    error.cause = err;
    return error;
}

/**
 * Creates a promise whose rejection is observed as soon as it exists.
 *
 * close() rejects every promise it owns - the in-flight and queued commands, the pending
 * connect(), the queued mailbox locks, the waiters for an IDLE break - synchronously, from a
 * socket event. A consumer that only reaches its `await` a microtask later has not attached a
 * handler yet at the moment Node decides whether the rejection was observed, and the whole
 * worker dies on the resulting unhandledRejection. The pre-attached observer settles that
 * question; the rejection still propagates normally to whoever awaits the returned promise.
 *
 * Creation and guarding are one call because splitting them is what actually goes wrong: the
 * guard was hand-attached at three of the four sites and the fourth (the IDLE-break waiter)
 * went unguarded, on exactly the path a server BYE takes.
 *
 * @param executor - Promise executor, (resolve, reject) => {}
 * @returns The promise, with its rejection already observed
 */
export function guardedPromise<T>(executor: (resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: any) => void) => void): Promise<T> {
    let promise = new Promise<T>(executor);
    promise.catch(noop);
    return promise;
}

/**
 * The already-rejected form of guardedPromise(), for a call that has to hand back a rejected
 * promise rather than throw.
 *
 * @param error - Rejection reason
 * @returns Rejected promise, with its rejection already observed
 */
export function guardedReject(error: Error): Promise<never> {
    let promise = Promise.reject<never>(error);
    promise.catch(noop);
    return promise;
}

/**
 * Detaches a background timer from the event loop, so it cannot keep the process alive on its
 * own. Applied to every background timer (auto-IDLE, IDLE restart, fallback polling, throttle
 * back-off, held-lock diagnostics); connection and greeting deadlines are deliberately left
 * attached, because a caller is waiting for connect() to settle.
 *
 * @param timer - Timer handle returned by setTimeout
 * @returns The same timer handle
 */
/**
 * Clears a timer that may already have been dropped. `clearTimeout()` accepts undefined but not
 * null, and the connection nulls its timer fields once cleared, so every site clears through here.
 *
 * @param timer - Timer handle returned by setTimeout, or null/undefined when none is armed
 */
export function clearTimer(timer: NodeJS.Timeout | null | undefined): void {
    if (timer) {
        clearTimeout(timer);
    }
}

export function unrefTimer<T extends NodeJS.Timeout | null | undefined>(timer: T): T {
    /* c8 ignore next 3 */ // node timers always expose unref(); the guard covers replaced globals in tests
    if (timer && typeof timer.unref === 'function') {
        timer.unref();
    }
    return timer;
}

/**
 * Logs a failure from background connection work at the level its cause deserves.
 *
 * Background work (IDLE sessions, polling timers, auto-IDLE) is interrupted by every normal
 * disconnect, so a rejection carrying one of the CONNECTION_GONE_CODES is expected rather
 * than notable and goes to debug. The three codes describe the same situation reached
 * through different guards: write() throws NoConnection or StateLogout, exec() rejects
 * EConnectionClosed for the window where the socket is destroyed but close() has not run
 * yet, and close() rejects pending requests with NoConnection.
 *
 * A connection error carrying `reason` is the exception. That field holds the server's
 * untagged BYE text ("Too many simultaneous connections", "Account is disabled"), which
 * serverBye() only records - this log call is the one place it becomes visible, and it is
 * usually the answer to why a client is reconnecting in a loop. Those stay at warn.
 *
 * Shared so the classification cannot drift between the call sites that make this decision.
 *
 * @param connection - IMAP connection instance
 * @param msg - What failed, so the entries stay distinguishable in the log
 * @param err - The error to log
 */
export function logConnectionError(connection: ImapFlow, msg: string, err: ImapFlowError | null | undefined): void {
    let routine = !!err && CONNECTION_GONE_CODES.has(err.code as string) && !err.reason;
    connection.log[routine ? 'debug' : 'warn']({ msg, err, cid: connection.id });
}

/**
 * Checks whether IMAP4rev2 semantics are active for the connection: either the
 * client enabled IMAP4rev2 explicitly, or the server is rev2-only (advertises
 * IMAP4rev2 without IMAP4rev1), in which case rev2 is the base protocol without
 * any ENABLE (RFC 9051 Appendix A). UTF-8 mailbox names apply in both cases.
 *
 * @param connection - IMAP connection instance
 * @returns True if IMAP4rev2 semantics apply to this session
 */
export function isRev2Active(connection: ImapFlow): boolean {
    return connection.enabled.has('IMAP4REV2') || (connection.capabilities.has('IMAP4rev2') && !connection.capabilities.has('IMAP4rev1'));
}

/**
 * Checks a capability, accounting for extensions that RFC 9051 folds into base
 * IMAP4rev2. Falls back to the plain capability lookup on IMAP4rev1 sessions,
 * so behavior against rev1 servers is unchanged.
 *
 * @param connection - IMAP connection instance
 * @param capability - Capability name, e.g. 'UIDPLUS'
 * @returns True if the capability (or its rev2-folded equivalent) is available
 */
export function hasCapability(connection: ImapFlow, capability: string): boolean {
    if (connection.capabilities.has(capability)) {
        return true;
    }
    return IMAP4REV2_FOLDED_CAPABILITIES.has(capability) && isRev2Active(connection);
}

/**
 * Builds the attribute list for a STATUS request - the standalone STATUS command
 * or the LIST-STATUS return option - from a status query object. Items the current
 * session cannot request (RECENT under IMAP4rev2, HIGHESTMODSEQ without CONDSTORE)
 * are silently dropped.
 *
 * @param connection - IMAP connection instance
 * @param statusQuery - Status data items to request, e.g. {messages: true}
 * @returns Attribute token list for the command compiler
 */
export function buildStatusQueryAttributes(connection: ImapFlow, statusQuery: StatusQuery | undefined): ImapAttributeNode[] {
    let attributes: ImapAttributeNode[] = [];
    let query = (statusQuery || {}) as { [key: string]: unknown };

    Object.keys(query).forEach(key => {
        if (!query[key]) {
            return;
        }

        switch (key.toUpperCase()) {
            case 'MESSAGES':
            case 'UIDNEXT':
            case 'UIDVALIDITY':
            case 'UNSEEN':
                attributes.push({ type: 'ATOM', value: key.toUpperCase() });
                break;

            case 'RECENT':
                // RECENT was removed in IMAP4rev2 (RFC 9051) - requesting it from a
                // rev2 session would get the whole STATUS request rejected
                if (!isRev2Active(connection)) {
                    attributes.push({ type: 'ATOM', value: key.toUpperCase() });
                }
                break;

            case 'HIGHESTMODSEQ':
                if (connection.capabilities.has('CONDSTORE')) {
                    attributes.push({ type: 'ATOM', value: key.toUpperCase() });
                }
                break;

            case 'SIZE':
                // STATUS SIZE requires the STATUS=SIZE extension (RFC 8438), which
                // RFC 9051 folds into base IMAP4rev2
                if (hasCapability(connection, 'STATUS=SIZE')) {
                    attributes.push({ type: 'ATOM', value: key.toUpperCase() });
                }
                break;

            case 'DELETED':
                // STATUS DELETED is a base IMAP4rev2 addition (RFC 9051 Appendix E
                // item 3) with no standalone capability - requesting it from a plain
                // rev1 server would get the whole STATUS request rejected. RFC 9208
                // additionally makes it mandatory when QUOTA=RES-MESSAGE is advertised.
                if (isRev2Active(connection) || connection.capabilities.has('QUOTA=RES-MESSAGE')) {
                    attributes.push({ type: 'ATOM', value: key.toUpperCase() });
                }
                break;
        }
    });

    return attributes;
}

/**
 * Encodes a mailbox path to modified UTF-7 if the server does not support UTF8=ACCEPT.
 *
 * @param connection - IMAP connection instance
 * @param path - Mailbox path to encode
 * @returns Encoded mailbox path
 */
export function encodePath(connection: ImapFlow, path: string | undefined): string {
    path = (path || '').toString();
    if (!connection.enabled.has('UTF8=ACCEPT') && !isRev2Active(connection) && /[&\x00-\x08\x0b-\x0c\x0e-\x1f\u0080-\uffff]/.test(path)) {
        try {
            path = iconv.encode(path, 'utf-7-imap').toString();
        } catch {
            // ignore, keep name as is
        }
    }
    return path;
}

/**
 * Decodes a mailbox path from modified UTF-7 if the server does not support UTF8=ACCEPT.
 *
 * @param connection - IMAP connection instance
 * @param path - Mailbox path to decode
 * @returns Decoded mailbox path
 */
export function decodePath(connection: ImapFlow, path: string | undefined): string {
    path = (path || '').toString();
    if (!connection.enabled.has('UTF8=ACCEPT') && !isRev2Active(connection) && /[&]/.test(path)) {
        try {
            path = iconv.decode(Buffer.from(path), 'utf-7-imap').toString();
        } catch {
            // ignore, keep name as is
        }
    }
    return path;
}

/**
 * Normalizes a mailbox path by joining array segments with the namespace delimiter,
 * uppercasing INBOX, and prepending the namespace prefix if needed.
 *
 * @param connection - IMAP connection instance
 * @param path - Mailbox path or array of path segments
 * @param skipNamespace - If true, skips prepending the namespace prefix
 * @returns Normalized mailbox path
 */
export function normalizePath(connection: ImapFlow, path: string | string[], skipNamespace?: boolean): string {
    if (Array.isArray(path)) {
        path = path.join((connection.namespace && connection.namespace.delimiter) || '');
    }

    if (path.toUpperCase() === 'INBOX') {
        // inbox is not case sensitive
        return 'INBOX';
    }

    // ensure namespace prefix if needed
    if (!skipNamespace && connection.namespace && connection.namespace.prefix && !path.startsWith(connection.namespace.prefix)) {
        path = connection.namespace.prefix + path;
    }

    return path;
}

/**
 * Compares two mailbox paths for equality after normalization.
 *
 * @param connection - IMAP connection instance
 * @param a - First mailbox path
 * @param b - Second mailbox path
 * @returns True if the paths are equal after normalization
 */
export function comparePaths(connection: ImapFlow, a: string | undefined, b: string | undefined): boolean {
    if (!a || !b) {
        return false;
    }
    return normalizePath(connection, a) === normalizePath(connection, b);
}

/**
 * Parses a capability response list into a Map of capability names to values.
 *
 * @param list - Array of capability objects from IMAP response
 * @returns Map of capability names to `true` or numeric values
 */
export function updateCapabilities(list: ImapAttributeList | null | undefined): Map<string, boolean | number> {
    let map = new Map<string, boolean | number>();

    if (list && Array.isArray(list)) {
        list.forEach(val => {
            // any entry can be a parsed NIL
            if (!val || typeof val.value !== 'string') {
                return;
            }
            let capability = val.value.toUpperCase().trim();

            if (capability === 'IMAP4REV1') {
                map.set('IMAP4rev1', true);
                return;
            }

            if (capability === 'IMAP4REV2') {
                map.set('IMAP4rev2', true);
                return;
            }

            if (capability.startsWith('APPENDLIMIT=')) {
                let splitPos = capability.indexOf('=');
                map.set('APPENDLIMIT', parseUintValue(capability.substr(splitPos + 1)) || 0);
                return;
            }

            map.set(capability, true);
        });
    }

    return map;
}

/**
 * Extracts the IMAP response status code (e.g. AUTHENTICATIONFAILED, NONEXISTENT)
 * from a parsed server response.
 *
 * @param response - Parsed IMAP server response
 * @returns Uppercase status code string, or false if not found
 */
export function getStatusCode(response: ImapResponse | string | false | undefined): string | false {
    return response &&
        typeof response === 'object' &&
        response.attributes &&
        response.attributes[0] &&
        response.attributes[0].section &&
        response.attributes[0].section[0] &&
        typeof response.attributes[0].section[0].value === 'string'
        ? response.attributes[0].section[0].value.toUpperCase().trim()
        : false;
}

/**
 * Compiles an IMAP response object back into a human-readable string.
 *
 * @param response - Parsed IMAP server response
 * @returns Compiled response text, or false if no response
 */
export async function getErrorText(response: ImapResponse | string | false | undefined): Promise<string | false> {
    if (!response) {
        return false;
    }

    try {
        return (await compiler(response as ImapCompileInput)).toString();
    } catch {
        // The wire encoder refuses values that cannot be expressed as a valid IMAP
        // string, which is what keeps user-supplied data from breaking out of a
        // command. A server response is not held to that: the parser deliberately
        // tolerates stray bytes inside an OK/NO/BAD atom, and those bytes then have
        // no valid re-encoding. This text is diagnostic, so fall back to the logging
        // encoder rather than replacing the server's error with an encoding failure.
        return (await compiler(response as ImapCompileInput, { isLogging: true })).toString();
    }
}

/**
 * Enhances an IMAP command error with the server response code and text.
 *
 * @param err - Error object with a `response` property
 * @returns The enhanced error with `serverResponseCode` and string `response`
 */
export async function enhanceCommandError(err: ImapFlowError): Promise<ImapFlowError> {
    let errorCode = getStatusCode(err.response);
    if (errorCode) {
        err.serverResponseCode = errorCode;
    }
    err.response = await getErrorText(err.response);
    return err;
}

/**
 * Converts a flat list of mailbox folders into a tree structure.
 *
 * @param folders - Array of folder objects from LIST/LSUB response
 * @returns Tree structure with a `root` flag and nested `folders` arrays
 */
export function getFolderTree(folders: ListResponse[]): ListTreeResponse {
    let tree: ListTreeResponse = {
        root: true,
        folders: []
    };

    let getTreeNode = (parents: string[] | undefined): ListTreeResponse => {
        let node = tree;
        if (!parents || !parents.length) {
            return node;
        }

        for (let parent of parents) {
            let cur = node.folders && node.folders.find(folder => folder.name === parent);
            if (cur) {
                node = cur;
            }
        }

        return node;
    };

    for (let folder of folders) {
        let parent = getTreeNode(folder.parent);
        // see if entry already exists
        let existing = parent.folders && parent.folders.find(existing => existing.name === folder.name);
        if (existing) {
            // update values
            existing.name = folder.name;
            existing.flags = folder.flags;
            existing.path = folder.path;
            existing.subscribed = !!folder.subscribed;
            existing.listed = !!folder.listed;
            existing.status = folder.status;

            if (folder.specialUse) {
                existing.specialUse = folder.specialUse;
            }

            if (folder.flags.has('\\Noselect')) {
                existing.disabled = true;
            }
            if (folder.flags.has('\\HasChildren') && !existing.folders) {
                existing.folders = [];
            }
        } else {
            // create new
            let data: ListTreeResponse = {
                name: folder.name,
                flags: folder.flags,
                path: folder.path,
                subscribed: !!folder.subscribed,
                listed: !!folder.listed,
                status: folder.status
            };

            if (folder.delimiter) {
                data.delimiter = folder.delimiter;
            }

            if (folder.specialUse) {
                data.specialUse = folder.specialUse;
            }

            if (folder.flags.has('\\Noselect')) {
                data.disabled = true;
            }

            if (folder.flags.has('\\HasChildren')) {
                data.folders = [];
            }

            if (!parent.folders) {
                parent.folders = [];
            }
            parent.folders.push(data);
        }
    }

    return tree;
}

/**
 * Derives a flag color name from a message's flags Set using Apple Mail color flag rules.
 *
 * @param flags - Message flags Set
 * @returns Color name (e.g. 'red', 'orange') or null if not flagged
 */
export function getFlagColor(flags: Set<string>): string | null {
    if (!flags.has('\\Flagged')) {
        return null;
    }

    // Apple Mail encodes flag colors as a 3-bit value using $MailFlagBit0/1/2 keywords.
    // Bit 0 = 1, Bit 1 = 2, Bit 2 = 4. The resulting integer (0-6) indexes into FLAG_COLORS:
    // 0=red, 1=orange, 2=yellow, 3=green, 4=blue, 5=purple, 6=grey.
    // Value 7 (all bits set) is unused; defaults to red.
    const bit0 = flags.has('$MailFlagBit0') ? 1 : 0;
    const bit1 = flags.has('$MailFlagBit1') ? 2 : 0;
    const bit2 = flags.has('$MailFlagBit2') ? 4 : 0;

    const color = bit0 | bit1 | bit2; // eslint-disable-line no-bitwise

    return FLAG_COLORS[color] ?? 'red'; // default to red for the unused \b111
}

/**
 * Converts a color name to the corresponding flag add/remove operations for Apple Mail color flags.
 *
 * @param color - Color name (e.g. 'red', 'orange', 'yellow')
 * @returns Object with `add` and `remove` arrays of flag strings, or null if invalid color
 */
export function getColorFlags(color: string | null | undefined): { add: string[]; remove: string[] } | null {
    // Reverse mapping from a color name to the Apple Mail $MailFlagBit0/1/2 flags.
    // Returns an object with 'add' and 'remove' arrays so the caller can STORE +FLAGS/-FLAGS.
    const colorCode = color ? FLAG_COLORS.indexOf(color.toString().toLowerCase().trim()) : null;
    if (colorCode === null || colorCode < 0) {
        if (colorCode === null) {
            // Remove color: remove \Flagged and all MailFlagBit flags
            return { add: [], remove: ['\\Flagged', '$MailFlagBit0', '$MailFlagBit1', '$MailFlagBit2'] };
        }
        return null;
    }

    // Decompose color index back into its 3-bit representation
    let result: { add: string[]; remove: string[] } = { add: ['\\Flagged'], remove: [] };
    for (let i = 0; i < 3; i++) {
        // eslint-disable-next-line no-bitwise
        if (colorCode & (1 << i)) {
            result.add.push(`$MailFlagBit${i}`);
        } else {
            result.remove.push(`$MailFlagBit${i}`);
        }
    }
    return result;
}

/**
 * Formats a raw untagged FETCH response into a structured message object.
 *
 * @param untagged - Parsed untagged IMAP response
 * @param mailbox - Current mailbox state object
 * @returns Formatted message object with properties like seq, uid, flags, envelope, etc.
 */
export async function formatMessageResponse(untagged: ImapResponse, mailbox: MailboxObject): Promise<FetchMessageObject> {
    let map: MessageMap = {};

    // The sequence number indexes into mailbox state, so an unusable one is dropped rather
    // than coerced to NaN or Infinity
    map.seq = parseUintValue(untagged.command, MAX_UINT32_DIGITS) || undefined;

    let key: string | undefined;
    let attributes = ((untagged.attributes && untagged.attributes[1]) || []) as ImapAttributeList;
    for (let i = 0, len = attributes.length; i < len; i++) {
        let attribute = attributes[i] as ImapAttribute;
        if (i % 2 === 0) {
            key = (
                await compiler({
                    attributes: [attribute]
                })
            )
                .toString()
                .toLowerCase()
                .replace(/<\d+(\.\d+)?>$/, '');
            continue;
        }
        /* c8 ignore start */ // defensive: key is always a string produced by the compiler above
        if (typeof key !== 'string') {
            // should not happen
            continue;
        }
        /* c8 ignore stop */

        let getString = (attribute: ImapAttribute): string | false | undefined => {
            if (!attribute) {
                return false;
            }
            if (typeof attribute.value === 'string') {
                return attribute.value;
            }
            if (Buffer.isBuffer(attribute.value)) {
                return attribute.value.toString();
            }
        };

        let getBuffer = (attribute: ImapAttribute): Buffer | false | undefined => {
            if (!attribute) {
                return false;
            }
            if (Buffer.isBuffer(attribute.value)) {
                return attribute.value;
            }
        };

        // NIL (parsed as null) and other non-array values yield an empty array, so callers
        // can safely index into the result. RFC 8474 allows e.g. `THREADID NIL` when the
        // server has no thread relation to report.
        let getArray = (attribute: ImapAttribute): string[] => getStringList(attribute);

        // Counts, sizes and UIDs are written into mailbox state and into range
        // computations, so only a bounded decimal run is usable - see parseUintValue().
        let getUint = (attribute: ImapAttribute, maxDigits?: number): number | false => parseUintValue(getString(attribute), maxDigits);

        switch (key) {
            case 'body[]':
            case 'binary[]':
                map.source = getBuffer(attribute) as Buffer | undefined;
                break;

            case 'uid':
                // A UID feeds mailbox.uidNext one line below, and from there every range
                // computation, so an unusable one is dropped rather than coerced
                map.uid = getUint(attribute, MAX_UINT32_DIGITS) || undefined;
                // If the UID we just saw is >= the mailbox's uidNext, bump uidNext.
                // This keeps the local uidNext estimate current without requiring a
                // separate STATUS command, handling cases where new messages arrived
                // since the last SELECT/EXAMINE.
                if (map.uid && (!mailbox.uidNext || mailbox.uidNext <= map.uid)) {
                    mailbox.uidNext = map.uid + 1;
                }
                break;

            case 'modseq': {
                // BigInt() throws on a non-numeric or missing value, and the throw
                // drops the whole message from the result set - so a malformed
                // MODSEQ from the server must be skipped, not surfaced.
                let modseq = parseBigIntValue(getArray(attribute)[0]);
                if (modseq === false) {
                    break;
                }
                map.modseq = modseq;
                // Similarly, keep the local highestModseq estimate up to date.
                // This is critical for CONDSTORE/QRESYNC delta syncing.
                if (map.modseq && (!mailbox.highestModseq || mailbox.highestModseq < map.modseq)) {
                    mailbox.highestModseq = map.modseq;
                }
                break;
            }

            case 'emailid':
                // OBJECTID extension (RFC 8474): server-assigned stable email identifier
                map.emailId = getArray(attribute)[0];
                break;

            case 'x-gm-msgid':
                // Gmail extension: X-GM-MSGID is Gmail's unique message ID.
                // Mapped to the same emailId field as OBJECTID for a unified API,
                // but this is a Gmail-specific numeric string, not an RFC 8474 ObjectID.
                map.emailId = getString(attribute) as string | undefined;
                break;

            case 'threadid':
                map.threadId = getArray(attribute)[0];
                break;

            case 'x-gm-thrid':
                map.threadId = getString(attribute) as string | undefined;
                break;

            case 'x-gm-labels':
                map.labels = new Set(getArray(attribute));
                break;

            case 'rfc822.size':
                map.size = getUint(attribute) || 0;
                break;

            case 'flags':
                map.flags = new Set(getArray(attribute));
                break;

            case 'envelope':
                map.envelope = parseEnvelope(attribute as ImapAttributeList);
                break;

            case 'bodystructure':
                map.bodyStructure = parseBodystructure(attribute as ImapAttributeList);
                break;

            case 'internaldate': {
                let value = getString(attribute);
                let date = new Date(value as string);
                if (date.toString() === 'Invalid Date') {
                    map.internalDate = value as string | undefined;
                } else {
                    map.internalDate = date;
                }
                break;
            }

            default: {
                let match = key.match(/(body|binary)\[/i);
                if (match) {
                    let partKey = key.replace(/^(body|binary)\[|]$/gi, '');
                    partKey = partKey.replace(/\.fields.*$/g, '');

                    let value = getBuffer(attribute) as Buffer;
                    if (partKey === 'header') {
                        map.headers = value;
                        break;
                    }

                    if (!map.bodyParts) {
                        map.bodyParts = new Map();
                    }
                    map.bodyParts.set(partKey, value);

                    if (match[1].toLowerCase() === 'binary') {
                        // The part arrived via FETCH BINARY (RFC 3516, FETCH side folded
                        // into IMAP4rev2), so the server has already removed the
                        // content-transfer-encoding - consumers must not decode it again.
                        // Recorded from the actual response, not predicted from the
                        // request, so it stays correct even if a server answers a BINARY
                        // request with a BODY response or vice versa.
                        if (!map.binaryParts) {
                            map.binaryParts = new Set();
                        }
                        map.binaryParts.add(partKey);
                    }
                    break;
                }
                break;
            }
        }
    }

    if (map.emailId || map.uid) {
        // define account unique ID for this email

        // normalize path to use ascii, so we would always get the same ID
        let path = mailbox.path;
        if (/[\u0080-\uffff]/.test(path)) {
            try {
                path = iconv.encode(path, 'utf-7-imap').toString();
            } catch {
                // ignore
            }
        }

        // Non-cryptographic identifier: MD5 is used only to derive a stable, compact
        // account-unique id from non-secret data (path:uidValidity:uid). No security
        // property (collision/preimage resistance, secrecy) is relied upon, so a fast
        // hash is the appropriate choice here - not a security-sensitive use.
        map.id =
            map.emailId ||
            createHash('md5')
                .update([path, mailbox.uidValidity?.toString() || '', (map.uid as number).toString()].join(':'))
                .digest('hex');
    }

    if (map.flags) {
        let flagColor = getFlagColor(map.flags);
        if (flagColor) {
            map.flagColor = flagColor;
        }
    }

    return map as FetchMessageObject;
}

/**
 * Strips surrounding double quotes from a name string.
 *
 * @param name - Raw name string potentially wrapped in quotes
 * @returns Name with surrounding quotes removed
 */
export function processName(name: unknown): string {
    let value = (name || '').toString();
    if (value.length > 2 && value.at(0) === '"' && value.at(-1) === '"') {
        value = value.slice(1, -1);
    }
    return value;
}

/**
 * Decodes an ENVELOPE text field for display: encoded words first, then the
 * surrounding quotes some servers leave in place.
 *
 * @param value - Raw field value from an ENVELOPE response
 * @returns Decoded, unquoted text
 */
export function decodeText(value: string): string {
    return processName(libmime.decodeWords(value));
}

/**
 * Parses a raw IMAP ENVELOPE response into a structured envelope object.
 *
 * @param entry - Raw envelope data array from IMAP response
 * @returns Parsed envelope with date, subject, from, to, cc, bcc, messageId, etc.
 */
export function parseEnvelope(entry: ImapAttributeList): MessageEnvelopeObject {
    let getStrValue = (obj: ImapAttribute): TokenStringValue => {
        if (!obj) {
            return false;
        }
        if (typeof obj.value === 'string') {
            return obj.value;
        }
        if (Buffer.isBuffer(obj.value)) {
            return obj.value.toString();
        }
        /* c8 ignore next */ // defensive: envelope tokens are always string/Buffer/NIL, never another type
        return obj.value;
    };

    let processAddresses = function (list: ImapAttributeList): MessageAddressObject[] {
            /* c8 ignore next 2 */ // defensive: processAddresses is only called with non-empty arrays, so the [] fallback is unreachable
            return ([] as ImapAttribute[])
                .concat(list || [])
                .map(addr => {
                    if (!addr) {
                        // A NIL entry inside an address list: skip it instead of
                        // throwing on the dereference and dropping the message
                        return false;
                    }

                    let entry = addr as ImapAttributeList;
                    let name = decodeText(getStrValue(entry[0]) as string);
                    let mailbox = (getStrValue(entry[2]) || '') as string;
                    let host = (getStrValue(entry[3]) || '') as string;

                    if (!host) {
                        // RFC 9051 7.5.2: a NIL host field marks RFC 5322 group syntax, it is not
                        // an empty domain. A non-NIL mailbox then holds the group name phrase, a
                        // NIL one closes the group. Joining the fields anyway would invent an
                        // address that never appeared in the message, eg. "undisclosed-recipients@",
                        // so surface the group name as a display name and leave the address empty.
                        // End-of-group markers carry neither and the filter below drops them.
                        // The mirror case, a NIL mailbox with a host, is left alone on purpose:
                        // the grammar gives it no meaning, so a server sending it is simply
                        // malformed rather than signalling anything we could act on.
                        return { name: name || (mailbox && decodeText(mailbox)), address: '' };
                    }

                    return { name, address: `${mailbox}@${host}` };
                })
                .filter((addr): addr is { name: string; address: string } => !!(addr && (addr.name || addr.address)));
        },
        envelope: MessageEnvelopeObject = {};

    if (entry[0] && entry[0].value) {
        let date = new Date(getStrValue(entry[0]) as string);
        if (date.toString() === 'Invalid Date') {
            envelope.date = getStrValue(entry[0]) as string;
        } else {
            envelope.date = date;
        }
    }

    if (entry[1] && entry[1].value) {
        envelope.subject = libmime.decodeWords(getStrValue(entry[1]) as string);
    }

    if (Array.isArray(entry[2]) && entry[2].length) {
        envelope.from = processAddresses(entry[2]);
    }

    if (Array.isArray(entry[3]) && entry[3].length) {
        envelope.sender = processAddresses(entry[3]);
    }

    if (Array.isArray(entry[4]) && entry[4].length) {
        envelope.replyTo = processAddresses(entry[4]);
    }

    if (Array.isArray(entry[5]) && entry[5].length) {
        envelope.to = processAddresses(entry[5]);
    }

    if (Array.isArray(entry[6]) && entry[6].length) {
        envelope.cc = processAddresses(entry[6]);
    }

    if (Array.isArray(entry[7]) && entry[7].length) {
        envelope.bcc = processAddresses(entry[7]);
    }

    if (entry[8] && entry[8].value) {
        /* c8 ignore next */ // the guard ensures getStrValue is truthy here, so the '' fallback is unreachable
        envelope.inReplyTo = (getStrValue(entry[8]) || '').toString().trim();
    }

    if (entry[9] && entry[9].value) {
        /* c8 ignore next */ // the guard ensures getStrValue is truthy here, so the '' fallback is unreachable
        envelope.messageId = (getStrValue(entry[9]) || '').toString().trim();
    }

    return envelope;
}

/**
 * Parses structured MIME parameter arrays (including RFC 2231 continuations)
 * into a flat key-value object.
 *
 * @param arr - Raw parameter array from BODYSTRUCTURE response
 * @returns Key-value object of decoded parameters
 */
export function getStructuredParams(arr: ImapAttributeList | null | undefined): { [key: string]: string } {
    let key: string | undefined;

    // Continuation parts are collected as {charset, values} objects before being joined
    // back into strings, so the map holds both shapes while it is being built
    let params: { [key: string]: any } = {};

    // BODYSTRUCTURE parameters come as flat key/value pairs: [key1, val1, key2, val2, ...]
    ([] as ImapAttribute[]).concat(arr || []).forEach((val, j) => {
        if (j % 2) {
            // Parameter names are server-controlled. The load-bearing check is the one in
            // the continuation pass below, where the value is an object; here the value is
            // always a string, which the __proto__ setter ignores anyway.
            if (!isUnsafeKey(key)) {
                params[key as string] = libmime.decodeWords(((val && val.value) || '').toString());
            }
        } else {
            key = ((val && val.value) || '').toString().toLowerCase();
        }
    });

    // Detect RFC 2231 encoded filenames that were placed in the plain 'filename' param
    // instead of 'filename*'. The pattern charset'language'encoded_value indicates encoding.
    if (params.filename && !params['filename*'] && /^[a-z\-_0-9]+'[a-z]*'[^'\x00-\x08\x0b\x0c\x0e-\x1f\u0080-\uffff]+/.test(params.filename)) {
        // seems like encoded value
        let [encoding, , encodedValue] = params.filename.split("'");
        if (resolveCharset(encoding)) {
            params['filename*'] = `${encoding}''${encodedValue}`;
        }
    }

    // RFC 2231 parameter continuations: parameters like filename*0, filename*1, etc.
    // are split parts of a single value. Parameters ending with '*' contain charset info.
    // This pass collects continuation parts and groups them by their base key name.
    Object.keys(params).forEach(key => {
        let actualKey: string;
        let nr: number;
        let value: string;

        // Match keys ending with *N or *N* (where N is the continuation index)
        let match: RegExpMatchArray | null = key.match(/\*((\d+)\*?)?$/);

        if (!match) {
            // nothing to do here, does not seem like a continuation param
            return;
        }

        actualKey = key.substr(0, match.index).toLowerCase();
        nr = Number(match[2]) || 0;

        if (isUnsafeKey(actualKey)) {
            // A continuation key like "__proto__*0*" would group under "__proto__":
            // params['__proto__'] resolves to Object.prototype, so the grouping
            // writes below would mutate it (process-wide pollution). Drop the part.
            delete params[key];
            return;
        }

        if (!params[actualKey] || typeof params[actualKey] !== 'object') {
            params[actualKey] = {
                charset: false,
                values: []
            };
        }

        value = params[key];

        // The first segment (*0*) may contain charset and language: charset'language'value
        if (nr === 0 && match[0].at(-1) === '*' && (match = value.match(/^([^']*)'[^']*'(.*)$/))) {
            params[actualKey].charset = match[1] || 'utf-8';
            value = match[2];
        }

        params[actualKey].values.push({ nr, value });

        // remove the old reference
        delete params[key];
    });

    // Reassemble split RFC 2231 strings by sorting continuation parts and joining them.
    // For charset-encoded values, convert URL-encoded (%XX) sequences to MIME quoted-printable
    // format (=?charset?Q?...?=) so libmime.decodeWords can decode them to Unicode.
    Object.keys(params).forEach(key => {
        let value: string;
        if (params[key] && Array.isArray(params[key].values)) {
            value = params[key].values
                .sort((a: { nr: number }, b: { nr: number }) => a.nr - b.nr)
                .map((val: { value?: string | undefined } | null | undefined) => (val && val.value) || '')
                .join('');

            if (params[key].charset) {
                // Convert URL encoding (%AB) to MIME quoted-printable (=AB) by:
                // 1. Escaping QP-special chars (=, ?, _, space) as %XX
                // 2. Replacing all '%' with '=' to switch from URL encoding to QP encoding
                // 3. Wrapping in =?charset?Q?...?= for libmime to decode
                params[key] = libmime.decodeWords(
                    '=?' +
                        params[key].charset +
                        '?Q?' +
                        value
                            // fix invalidly encoded chars
                            .replace(/[=?_\s]/g, s => {
                                if (s === ' ') {
                                    return '_';
                                }
                                let c = s.charCodeAt(0).toString(16);
                                return '%' + (c.length < 2 ? '0' : '') + c;
                            })
                            // change from urlencoding to percent encoding
                            .replace(/%/g, '=') +
                        '?='
                );
            } else {
                params[key] = libmime.decodeWords(value);
            }
        }
    });

    return params;
}

/**
 * Parses a raw IMAP BODYSTRUCTURE response into a structured tree of body parts.
 *
 * @param entry - Raw BODYSTRUCTURE data array from IMAP response
 * @returns Parsed body structure tree with part numbers, types, parameters, and child nodes
 */
export function parseBodystructure(entry: ImapAttributeList): MessageStructureObject {
    // Recursively walks the BODYSTRUCTURE tree, building MIME part numbers.
    // Part numbers follow the IMAP dot-notation: "1", "1.1", "2.3", etc.
    // The root multipart has no part number; its children start at 1.
    let walk = (node: ImapAttributeList, path?: number[]): MessageStructureObject => {
        path = path || [];

        let curNode = {} as MessageStructureObject,
            i = 0,
            part = 0;

        // Build the dot-separated part number from the path array (e.g., [1,2] -> "1.2")
        if (path.length) {
            curNode.part = path.join('.');
        }

        // multipart: first elements are arrays (child body parts), followed by the subtype string
        if (Array.isArray(node[0])) {
            curNode.childNodes = [];
            // Each child array is a nested body part; increment part counter for each
            while (Array.isArray(node[i])) {
                curNode.childNodes.push(walk(node[i] as ImapAttributeList, path.concat(++part)));
                i++;
            }

            // multipart type
            curNode.type = 'multipart/' + ((node[i++] || ({} as ImapAttributeNode)).value || '').toString().toLowerCase();

            // extension data (not available for BODY requests)

            // body parameter parenthesized list
            if (i < node.length - 1) {
                if (node[i]) {
                    curNode.parameters = getStructuredParams(node[i] as ImapAttributeList);
                }
                i++;
            }
        } else {
            // content type
            curNode.type = [
                ((node[i++] || ({} as ImapAttributeNode)).value || '').toString().toLowerCase(),
                ((node[i++] || ({} as ImapAttributeNode)).value || '').toString().toLowerCase()
            ].join('/');

            // body parameter parenthesized list
            if (node[i]) {
                curNode.parameters = getStructuredParams(node[i] as ImapAttributeList);
            }
            i++;

            // id
            if (node[i]) {
                curNode.id = (node[i]!.value || '').toString();
            }
            i++;

            // description
            if (node[i]) {
                curNode.description = (node[i]!.value || '').toString();
            }
            i++;

            // encoding
            if (node[i]) {
                curNode.encoding = (node[i]!.value || '').toString().toLowerCase();
            }
            i++;

            // size
            if (node[i]) {
                curNode.size = Number(node[i]!.value || 0) || 0;
            }
            i++;

            if (curNode.type === 'message/rfc822') {
                // message/rfc822 is special in IMAP BODYSTRUCTURE: after the standard
                // 7 fields, it includes an embedded envelope, a nested bodystructure,
                // and a line count for the encapsulated message.

                // envelope of the encapsulated message
                if (node[i]) {
                    /* c8 ignore next */ // node[i] is truthy inside this guard, so the [] fallback is unreachable
                    curNode.envelope = parseEnvelope(([] as ImapAttribute[]).concat(node[i] || []) as ImapAttributeList);
                }
                i++;

                if (node[i]) {
                    curNode.childNodes = [
                        // The nested bodystructure reuses the same path (not path+1) because
                        // the encapsulated message shares the part number with its wrapper.
                        // Distinction is via suffixes: path.MIME = wrapper headers,
                        // path.HEADER = encapsulated message headers.
                        walk(node[i] as ImapAttributeList, path)
                    ];
                }
                i++;

                // line count
                if (node[i]) {
                    curNode.lineCount = Number(node[i]!.value || 0) || 0;
                }
                i++;
            }

            if (/^text\//.test(curNode.type)) {
                // Per RFC 3501, text/* parts include an additional line count field after size.
                // However, some servers omit this field, producing 11 elements instead of 12+.

                // NB! some less known servers do not include the line count value
                // length should be 12+
                if (node.length === 11 && Array.isArray(node[i + 1]) && !Array.isArray(node[i + 2])) {
                    // invalid structure, disposition params are shifted - skip the line count
                } else {
                    // correct structure, line count number is provided
                    if (node[i]) {
                        curNode.lineCount = Number(node[i]!.value || 0) || 0;
                    }
                    i++;
                }
            }

            // extension data (not available for BODY requests)

            // md5
            if (i < node.length - 1) {
                if (node[i]) {
                    curNode.md5 = (node[i]!.value || '').toString().toLowerCase();
                }
                i++;
            }
        }

        // the following are shared extension values (for both multipart and non-multipart parts)
        // not available for BODY requests

        // body disposition
        if (i < node.length - 1) {
            let disposition = node[i];
            if (Array.isArray(disposition) && disposition.length) {
                curNode.disposition = ((disposition[0] && disposition[0].value) || '').toString().toLowerCase();
                if (Array.isArray(disposition[1])) {
                    curNode.dispositionParameters = getStructuredParams(disposition[1]);
                }
            }
            i++;
        }

        // body language
        if (i < node.length - 1) {
            if (node[i]) {
                /* c8 ignore next */ // node[i] is truthy inside this guard, so the [] fallback is unreachable
                curNode.language = ([] as ImapAttribute[]).concat(node[i] || []).map(val => ((val && val.value) || '').toString().toLowerCase());
            }
            i++;
        }

        // body location
        // NB! defined as a "string list" in RFC3501 but replaced in errata document with "string"
        // Errata: http://www.rfc-editor.org/errata_search.php?rfc=3501
        if (i < node.length - 1) {
            if (node[i]) {
                curNode.location = (node[i]!.value || '').toString();
            }
        }

        return curNode;
    };

    return walk(entry);
}

/**
 * Checks if a value is a Date object.
 *
 * @param obj - Value to check
 * @returns True if the value is a Date object
 */
export function isDate(obj: unknown): obj is Date {
    return Object.prototype.toString.call(obj) === '[object Date]';
}

/**
 * Converts a value to a valid Date object, or returns null.
 *
 * @param value - Date object or date string to convert
 * @returns Valid Date object, or null if conversion fails
 */
export function toValidDate(value: unknown): Date | null {
    if (!value) {
        return null;
    }
    if (typeof value === 'string') {
        value = new Date(value);
    }
    if (!isDate(value) || value.toString() === 'Invalid Date') {
        return null;
    }
    return value;
}

/**
 * Formats a date value into IMAP date format (DD-Mon-YYYY).
 *
 * @param value - Date to format
 * @returns Formatted date string, or undefined if invalid
 */
export function formatDate(value: Date | string | null | undefined): string | undefined {
    let date = toValidDate(value);
    if (!date) {
        return;
    }

    let dateParts = date.toISOString().substr(0, 10).split('-');
    dateParts.reverse();

    let months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    dateParts[1] = months[Number(dateParts[1]) - 1];

    return dateParts.join('-');
}

/**
 * Formats a date value into IMAP date-time format (DD-Mon-YYYY HH:MM:SS +0000).
 *
 * @param value - Date to format
 * @returns Formatted date-time string, or undefined if invalid
 */
export function formatDateTime(value: Date | string | null | undefined): string | undefined {
    let date = toValidDate(value);
    if (!date) {
        return;
    }

    let dateStr = (formatDate(date) as string).replace(/^0/, ' '); //starts with date-day-fixed with leading 0 replaced by SP
    let timeStr = date.toISOString().substr(11, 8);

    return `${dateStr} ${timeStr} +0000`;
}

/**
 * Normalizes a flag string. Returns false for non-settable flags (e.g. \Recent),
 * and capitalizes system flags properly.
 *
 * @param flag - Flag string to normalize
 * @returns Normalized flag string, or false if the flag cannot be set
 */
export function formatFlag(flag: string): string | false {
    switch (flag.toLowerCase()) {
        case '\\recent':
            // can not set or remove
            return false;
        case '\\seen':
        case '\\answered':
        case '\\flagged':
        case '\\deleted':
        case '\\draft':
            // normalize capitalization (e.g., "\\seen" -> "\\Seen")
            return flag.toLowerCase().replace(/^\\./, c => c.toUpperCase());
    }
    return flag;
}

/**
 * Checks if a flag can be used in the given mailbox based on permanent flags.
 *
 * @param mailbox - Mailbox object with permanentFlags
 * @param flag - Flag to check
 * @returns True if the flag is allowed
 */
export function canUseFlag(mailbox: MailboxObject | false | null | undefined, flag: string): boolean {
    return !mailbox || !mailbox.permanentFlags || mailbox.permanentFlags.has('\\*') || mailbox.permanentFlags.has(flag);
}

/**
 * Checks that a value is a valid IMAP sequence number or UID: a non-zero
 * 32-bit unsigned integer (nz-number in the RFC 9051 grammar). Guards range
 * expansion against untrusted server input such as 'Infinity' or '0:*'.
 *
 * @param value - Value to check
 * @returns True if the value is a valid sequence number/UID
 */
export function isValidSequenceValue(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 0xffffffff;
}

/**
 * Checks that an untrusted response value is a pure decimal digit run no longer than
 * the given bound.
 *
 * `!isNaN(value)` is not usable for this: it also passes '1e5', ' 12 ', '0x10' and
 * 'Infinity'. BigInt() throws on all of them and Number() silently returns a value the
 * grammar never allowed, so both are wrong in a response handler that is only trying to
 * read one field. The length bound is checked before the pattern so an arbitrarily long
 * digit run is rejected without any conversion work.
 *
 * @param value - Raw value from the response.
 * @param maxDigits - Maximum number of digits accepted.
 * @returns True if the value is a decimal string within the bound.
 */
export function isDecimalString(value: unknown, maxDigits: number): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= maxDigits && /^[0-9]+$/.test(value);
}

/**
 * Checks whether a server-supplied string is unsafe to use as a key on a plain object.
 * Assigning "__proto__" writes through the prototype setter instead of creating an own
 * property, and reading "constructor" or "prototype" resolves to an inherited member.
 *
 * @param key - Candidate key from a server response.
 * @returns True if the key must not be used.
 */
export function isUnsafeKey(key: unknown): boolean {
    return UNSAFE_OBJECT_KEYS.has(key as string);
}

/**
 * Reads a parsed attribute list of atoms or strings (a flag list, a capability list) into
 * an array of strings. Any element can be a parsed NIL, and the list itself can be NIL,
 * so both levels are guarded here rather than at each call site.
 *
 * @param list - Parsed attribute list from a response.
 * @returns The string values, in order, with unusable entries dropped.
 */
export function getStringList(list: unknown): string[] {
    if (!Array.isArray(list)) {
        return [];
    }
    return list.map(entry => (entry && typeof entry.value === 'string' ? entry.value : false)).filter(entry => entry);
}

/**
 * Parses an untrusted decimal value from a server response into a BigInt.
 *
 * @param value - Raw value from the response.
 * @param maxDigits - Maximum number of digits accepted. Defaults to MAX_NUMBER64_DIGITS.
 * @returns The parsed value, or false when it is not usable.
 */
export function parseBigIntValue(value: unknown, maxDigits?: number): bigint | false {
    if (!isDecimalString(value, maxDigits || MAX_NUMBER64_DIGITS)) {
        return false;
    }
    return BigInt(value);
}

/**
 * Parses an untrusted decimal value from a server response into a Number. Values beyond
 * the safe integer range are rejected rather than rounded: a silently rounded count or
 * UID corrupts every range computation derived from it.
 *
 * @param value - Raw value from the response.
 * @param maxDigits - Maximum number of digits accepted. Defaults to MAX_NUMBER64_DIGITS.
 * @returns The parsed value, or false when it is not usable.
 */
export function parseUintValue(value: unknown, maxDigits?: number): number | false {
    if (!isDecimalString(value, maxDigits || MAX_NUMBER64_DIGITS)) {
        return false;
    }
    let num = Number(value);
    return Number.isSafeInteger(num) ? num : false;
}

/**
 * Expands an IMAP sequence range string (e.g. "1:3,5,7:9") into an array of numbers.
 *
 * Entries with endpoints that are not valid nz-numbers are skipped - the input
 * may come from an untrusted server, and 'Infinity' or similar garbage would
 * otherwise loop without bound. The whole set is expanded to at most
 * EXPANDED_RANGE_LIMIT entries in total: legitimate responses never reach the limit
 * (the mailbox would need that many messages), while hostile input is cut off
 * instead of exhausting memory. The total is capped, not just each range -
 * otherwise "1:16777216,1:16777216,..." would multiply the per-range bound by an
 * unbounded number of ranges.
 *
 * @param range - IMAP sequence range string
 * @returns Array of expanded sequence numbers
 */
export function expandRange(range: unknown): number[] {
    let result: number[] = [];
    // Callers pass whatever the response parser produced for the sequence set, and a
    // malformed response can leave that as `false` (e.g. a VANISHED response carrying
    // only the (EARLIER) tag). Nothing to expand then, and throwing here would abort
    // the handler for the rest of the response.
    if (typeof range !== 'string') {
        return result;
    }
    for (let entry of range.split(',')) {
        if (result.length >= EXPANDED_RANGE_LIMIT) {
            break;
        }
        entry = entry.trim();
        let colon = entry.indexOf(':');
        if (colon < 0) {
            let value = Number(entry);
            if (isValidSequenceValue(value)) {
                result.push(value);
            }
            continue;
        }
        let first = Number(entry.substr(0, colon));
        let second = Number(entry.substr(colon + 1));
        if (!isValidSequenceValue(first) || !isValidSequenceValue(second)) {
            continue;
        }
        if (first === second) {
            result.push(first);
            continue;
        }
        // Remaining total budget doubles as the per-range bound
        let remaining = EXPANDED_RANGE_LIMIT - result.length;
        if (first < second) {
            let last = Math.min(second, first + remaining - 1);
            for (let i = first; i <= last; i++) {
                result.push(i);
            }
        } else {
            let last = Math.max(second, first - remaining + 1);
            for (let i = first; i >= last; i--) {
                result.push(i);
            }
        }
    }
    return result;
}

/**
 * Returns a stream decoder for the given charset. Uses a special Japanese
 * charset decoder for JIS/ISO-2022-JP, otherwise delegates to iconv-lite.
 *
 * @param charset - Character set name. Defaults to 'ascii'.
 * @param maxBytes - Bound for the bytes the decoder may buffer. Only
 *   relevant for the Japanese decoder, which must buffer its whole input before
 *   it can decode: without the bound a server could defeat a caller's maxBytes
 *   download limit simply by labelling the part with a Japanese charset.
 * @returns A stream decoder (Transform stream) for the charset
 */
export function getDecoder(charset?: string | undefined, maxBytes?: number | undefined): CharsetDecoder {
    charset = (charset || 'ascii').toString().trim().toLowerCase();
    if (/^jis|^iso-?2022-?jp|^euc-?jp/.test(charset)) {
        // special case not supported by iconv-lite
        return new JPDecoder(charset, maxBytes);
    }

    return iconv.decodeStream(charset as Parameters<typeof iconv.decodeStream>[0]) as unknown as CharsetDecoder;
}

/**
 * Packs an array of message sequence numbers into a compact IMAP range string
 * (e.g. [1,2,3,5,7,8] becomes "1:3,5,7:8").
 *
 * @param list - Sequence number or array of sequence numbers
 * @returns Packed IMAP sequence range string
 */
export function packMessageRange(list: number | number[] | null | undefined): string {
    let items: number[];
    if (!Array.isArray(list)) {
        items = ([] as number[]).concat(list || []);
    } else {
        items = list;
    }

    if (!items.length) {
        return '';
    }

    // Deduplicate before sorting so that repeated values do not produce
    // overlapping/non-canonical tokens (e.g. [1,1,2,3] -> "1:3", not "1,1:3").
    items = Array.from(new Set(items)).sort((a, b) => a - b);

    let last = items[items.length - 1];
    let result: number[][] = [[last]];
    for (let i = items.length - 2; i >= 0; i--) {
        if (items[i] === items[i + 1] - 1) {
            result[0].unshift(items[i]);
            continue;
        }
        result.unshift([items[i]]);
    }

    let parts = result.map(item => {
        if (item.length === 1) {
            return item[0];
        }
        return item.shift() + ':' + item.pop();
    });

    return parts.join(',');
}
