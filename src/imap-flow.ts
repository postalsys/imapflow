/**
 * @module imapflow
 */

import tls from 'node:tls';
import net from 'node:net';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { EventEmitter } from 'node:events';
import { PassThrough, type Readable, type Transform } from 'node:stream';
import libmime from 'libmime';
import libqp from 'libqp';
import libbase64 from 'libbase64';
import { Headers } from '@zone-eu/mailsplit';
import FlowedDecoder from '@zone-eu/mailsplit/lib/flowed-decoder.js';

import logger from './logger.js';
import * as packageInfo from './package-info.js';
import { LimitedPassthrough, normalizeByteLimit } from './limited-passthrough.js';
import { ImapStream } from './handler/imap-stream.js';
import { parser, compiler } from './handler/imap-handler.js';
import { proxyConnection, detachEarlyErrorHandler } from './proxy-connection.js';
import { ConnectionDeadline } from './connection-deadline.js';
import { AuthenticationFailure, type ConnectionErrorSite, type ImapFlowError } from './errors.js';
import imapCommands, { type CommandHandler } from './imap-commands.js';

import {
    comparePaths,
    updateCapabilities,
    getFolderTree,
    formatMessageResponse,
    getDecoder,
    packMessageRange,
    normalizePath,
    expandRange,
    getColorFlags,
    hasCapability,
    isRev2Active,
    logConnectionError,
    unrefTimer,
    clearTimer,
    parseUintValue,
    isUnsafeKey,
    getStringList,
    buildConnectionError,
    guardedPromise,
    guardedReject,
    MAX_UINT32_DIGITS
} from './tools.js';

import type {
    AppendResponseObject,
    CopyResponseObject,
    DownloadManyOptions,
    DownloadManyResult,
    DownloadMeta,
    DownloadObject,
    DownloadOptions,
    ESearchResult,
    ExpungeEvent,
    FetchMessageObject,
    FetchOptions,
    FetchQueryObject,
    FlagsEvent,
    IdInfoObject,
    ImapFlowEvents,
    ImapFlowOptions,
    InternalLogger,
    ListOptions,
    ListResponse,
    ListTreeResponse,
    LogLevel,
    MailboxCreateResponse,
    MailboxDeleteResponse,
    MailboxLockObject,
    MailboxLockOptions,
    MailboxObject,
    MailboxOpenOptions,
    MailboxRenameResponse,
    MessageRange,
    MessageRangeOptions,
    MessageStructureObject,
    NamespaceObject,
    NamespacesObject,
    QuotaResponse,
    SearchObject,
    SearchOptions,
    SearchReturnOption,
    SequenceString,
    StatusObject,
    StatusQuery,
    StoreOptions,
    TlsInfo
} from './types.js';
import type { ImapAttributeList, ImapAttributeNode, ImapCompileNode, ImapResponse, ImapStreamItem, SelectCommand } from './handler/types.js';
import type { ProxySocket } from './proxy-connection.js';

export type * from './types.js';
export type { ImapFlowError } from './errors.js';
export { AuthenticationFailure } from './errors.js';
export type { ImapAttribute, ImapAttributeList, ImapAttributeNode, ImapResponse } from './handler/types.js';

const GREETING_TIMEOUT = 16 * 1000;
const UPGRADE_TIMEOUT = 10 * 1000;

const SOCKET_TIMEOUT = 5 * 60 * 1000;

// Ceiling for any throttle back-off wait. Both the connection-level back-off and the per-command
// retries derive their delay from server-supplied hints, which are unbounded.
const MAX_THROTTLE_DELAY = 5 * 60 * 1000;

// Default threshold for warning that a mailbox lock has been held for a long
// time. Intended to catch forgotten release() calls, not legitimate long ops
// (e.g. fetching hundreds of thousands of messages). Configurable via the
// ImapFlow constructor option `maxLockHoldTime`. Set to 0 or false to disable.
const HELD_LOCK_WARN_MS = 30 * 60 * 1000;

// How long the connection has to stay inactive before auto-IDLE starts. Long enough that a caller
// running a sequence of commands is not interrupted by an IDLE it immediately has to break.
// Configurable via the ImapFlow constructor option `autoIdleDelay`.
const AUTO_IDLE_DELAY = 15 * 1000;

// Headroom kept between the auto-IDLE delay and the socket inactivity watchdog, so IDLE reaches
// the wire before the watchdog can fire. See normalizeAutoIdleDelay().
const AUTO_IDLE_SOCKET_MARGIN = 1000;

// Commands whose client frames carry credentials; the raw traffic log withholds frame content
// while one of these is in flight. See the logRaw branch in write().
const RAW_SENSITIVE_COMMANDS = new Set(['LOGIN', 'AUTHENTICATE']);

// Stand-in payload for a withheld raw client frame. Fixed width, so the entry says nothing
// about the length of what it replaced.
const RAW_HIDDEN_PLACEHOLDER = Buffer.from('(* value hidden *)\r\n').toString('base64');

// Whether any attribute of a command is marked as a secret. Recurses into nested lists because
// the command compiler honors `sensitive` at any depth, and the two must agree on what counts.
function hasSensitiveAttribute(attributes: ImapCompileNode | ImapCompileNode[] | undefined): boolean {
    return ([] as ImapCompileNode[])
        .concat(attributes || [])
        .some(node => (Array.isArray(node) ? hasSensitiveAttribute(node) : !!node && typeof node === 'object' && !Buffer.isBuffer(node) && !!node.sensitive));
}

// How deep flattenLoggedError() follows a chain of errors. Bounded because the chain comes from
// whatever failed, not from this library: a cause chain can be arbitrarily long, and the cycle
// check below only catches errors that repeat.
const MAX_ERROR_FLATTEN_DEPTH = 4;

// Recognizes an Error without instanceof, which fails for an error that crossed a realm boundary
// (worker thread, vm context) even though it serializes exactly the same way.
function isErrorLike(value: unknown): value is Error & { [key: string]: any } {
    return (
        value instanceof Error ||
        (!!value && typeof value === 'object' && typeof (value as any).message === 'string' && typeof (value as any).stack === 'string')
    );
}

// An Error carries `message` and `stack` on its prototype rather than as own enumerable
// properties, so JSON.stringify() renders one as `{}` and both logger fallback paths (the console
// fallback and emitLogs) would drop everything identifying it. Flattening happens here for both,
// so their shapes cannot drift apart.
//
// Nested errors are flattened too, because the top level is often not where the answer is: this
// library attaches the underlying failure as an enumerable `_err` (proxy setup, response
// processing, normalized connection deadlines), and Node reports a multi-address connect failure
// as an AggregateError whose members hold the per-address causes.
function flattenLoggedError(value: any, depth = 0, seen = new Set<unknown>()): any {
    if (depth >= MAX_ERROR_FLATTEN_DEPTH) {
        return isErrorLike(value) ? value.message : value;
    }

    if (Array.isArray(value)) {
        return value.map(entry => flattenLoggedError(entry, depth + 1, seen));
    }

    if (!isErrorLike(value)) {
        // Anything else is left alone: exploding a Buffer would produce one key per byte, and a
        // Date would become a pair of undefined fields.
        return value;
    }

    // A repeat renders as its message alone, so a chain that loops back does not restate a full
    // stack for every level down to the depth cap
    if (seen.has(value)) {
        return value.message;
    }
    seen.add(value);

    let flatErr: { [key: string]: any } = {
        message: value.message,
        stack: value.stack
    };

    // `cause` (passed through the Error options argument) and the AggregateError members are own
    // properties but not enumerable, so Object.keys does not list them
    for (let key of new Set([...Object.keys(value), 'cause', 'errors'])) {
        if (key in value) {
            flatErr[key] = flattenLoggedError(value[key], depth + 1, seen);
        }
    }

    return flatErr;
}

// The largest delay setTimeout can honor (2^31 - 1 ms). Anything above fires after 1 ms instead,
// so the auto-IDLE delay cap has to stay inside this range even when socketTimeout is not.
const MAX_TIMER_DELAY = 2 ** 31 - 1;

const stateValues = {
    NOT_AUTHENTICATED: 0x01,
    AUTHENTICATED: 0x02,
    SELECTED: 0x03,
    LOGOUT: 0x04
} as const;

/** One of the `ImapFlow#states` values */
export type ConnectionState = (typeof stateValues)[keyof typeof stateValues];

/**
 * The connection state constants, see `ImapFlow#states`. Every member is typed as the whole
 * union, so a list of states accepts any state in an `includes()` check
 */
export type ConnectionStates = { readonly [K in keyof typeof stateValues]: ConnectionState };

const states: ConnectionStates = stateValues;

/**
 * The socket carrying the IMAP session. A TLS socket exposes `getCipher()` and `authorized`, a
 * cleartext socket does not, and the code checks for them at runtime.
 */
export type ImapSocket = net.Socket & {
    getCipher?: (() => tls.CipherNameAndProtocol) | undefined;
    authorized?: boolean | undefined;
};

/**
 * Where outgoing bytes are written: the socket itself, or the PassThrough that feeds the
 * DEFLATE stream once compression is active
 */
export type WriteSocket = (ImapSocket | PassThrough) & { destroySoon?: (() => void) | undefined };

/**
 * Handler for an untagged response, registered per command or on the connection
 * @internal
 */
export type UntaggedHandler = (untagged: ImapResponse, ...args: any[]) => Promise<any> | void;

/**
 * Handler for a response code section such as `[CAPABILITY ...]`
 * @internal
 */
export type SectionHandler = (section: ImapAttributeList) => Promise<void> | void;

/**
 * Options for `ImapFlow#exec()`
 * @internal
 */
export interface ExecOptions {
    /** Comment logged next to the command */
    comment?: string | undefined;
    /** Untagged response handlers that apply while this command is in flight, keyed by response name */
    untagged?: { [command: string]: UntaggedHandler } | false | undefined;
    /** Handler for "+" continuation requests, used by IDLE and AUTHENTICATE */
    onPlusTag?: ((response: ImapResponse) => Promise<void> | void) | undefined;
    /** Called once the command line has been written to the socket */
    onSend?: (() => void) | undefined;
}

/**
 * The settled result of `ImapFlow#exec()`. `next()` must be called once the handler has
 * applied the response, it releases the dispatch of the next queued command.
 * @internal
 */
export interface ExecResponse {
    response: ImapResponse;
    next: () => void;
    /** Whether more input was already buffered after the tagged response line */
    hasTrailingData?: boolean | undefined;
}

/**
 * A command waiting to be written, or in flight
 * @internal
 */
export interface QueuedRequest {
    tag: string;
    command: string;
    attributes: ImapCompileNode[] | false | undefined;
    options: ExecOptions;
    /** Set once the command line is on the wire, see `ImapFlow#send()` */
    sent?: boolean | undefined;
}

/**
 * The promise side of a queued request
 * @internal
 */
export interface PendingRequest {
    command: string;
    attributes: ImapCompileNode[] | false | undefined;
    options: ExecOptions;
    resolve: (value: ExecResponse) => void;
    reject: (err: Error) => void;
}

interface ThrottleWaitEntry {
    resolve: (aborted: boolean) => void;
    timer?: NodeJS.Timeout | undefined;
}

/**
 * A queued or held mailbox lock
 * @internal
 */
export interface MailboxLockEntry {
    resolve: (lock: MailboxLockObject) => void;
    reject: (err: Error) => void;
    path: string;
    options: MailboxLockOptions;
    lockId: number;
    acquireTimer?: NodeJS.Timeout | null | undefined;
    heldWarnTimer?: NodeJS.Timeout | null | undefined;
    heldAt?: number | undefined;
}

/** A row queued by the FETCH handler for the `fetch()` generator */
interface FetchRow {
    response: FetchMessageObject;
    next: () => void;
}

type FetchQueueEntry = { value: FetchRow; err?: undefined } | { err: Error; value?: undefined };

/**
 * Normalizes the configured auto-IDLE delay into a value `setTimeout` can honor. Anything Node
 * would silently turn into a 1ms timer - NaN, a negative number, a value above the 32-bit range -
 * falls back to the default instead, because a 1ms delay means an IDLE/DONE round trip around
 * every single command. The delay is also capped below `socketTimeout`, see AUTO_IDLE_SOCKET_MARGIN.
 *
 * @param value - The configured `autoIdleDelay` option.
 * @param socketTimeout - The normalized socket inactivity timeout.
 * @param log - Logger, used to report a value that could not be used as given.
 * @param cid - Connection id for the log entry.
 * @returns Delay in milliseconds.
 */
const normalizeAutoIdleDelay = (value: unknown, socketTimeout: number, log: InternalLogger, cid: string): number => {
    const maxDelay = Math.max(0, Math.min(socketTimeout, MAX_TIMER_DELAY) - AUTO_IDLE_SOCKET_MARGIN);
    const configured = value !== undefined && value !== null;

    // Numeric strings are accepted, because configuration usually arrives from an environment
    // variable or a JSON file. Booleans and blank strings are not: Number() would read them as 0,
    // i.e. "IDLE around every command", the opposite of the "off" they suggest.
    let delay = typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN;
    let reason: string | null = null;

    if (!Number.isFinite(delay) || delay < 0) {
        reason = 'not a non-negative finite number';
        delay = AUTO_IDLE_DELAY;
    }

    if (delay > maxDelay) {
        // An invalid value keeps its own reason: the cap then applies to the fallback default,
        // not to anything the caller asked for.
        reason = reason || `above socketTimeout (${socketTimeout} ms)`;
        delay = maxDelay;
    }

    // Only an explicitly configured value is worth warning about. Capping the default because the
    // caller picked a short socketTimeout is expected behavior, not a misconfiguration.
    if (configured && reason) {
        log.warn({ msg: 'Adjusted unusable autoIdleDelay option', requested: value, autoIdleDelay: delay, reason, cid });
    }

    return Math.floor(delay);
};

// The class extends the plain EventEmitter rather than EventEmitter<ImapFlowEvents>: the
// generic form only exists in @types/node 20.11.21 and later, and a consumer on an older
// release would lose every emitter method of the class. Each method gets an overload generic
// over ImapFlowEvents, which types the listener from the event name, plus the string
// catch-all of the base class, so that an event outside the map still compiles.

/**
 * Typed event overloads of the {@link ImapFlow} class, see {@link ImapFlowEvents}
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface ImapFlow {
    on<K extends keyof ImapFlowEvents>(event: K, listener: (...args: ImapFlowEvents[K]) => void): this;
    on(event: string | symbol, listener: (...args: any[]) => void): this;
    once<K extends keyof ImapFlowEvents>(event: K, listener: (...args: ImapFlowEvents[K]) => void): this;
    once(event: string | symbol, listener: (...args: any[]) => void): this;
    off<K extends keyof ImapFlowEvents>(event: K, listener: (...args: ImapFlowEvents[K]) => void): this;
    off(event: string | symbol, listener: (...args: any[]) => void): this;
    addListener<K extends keyof ImapFlowEvents>(event: K, listener: (...args: ImapFlowEvents[K]) => void): this;
    addListener(event: string | symbol, listener: (...args: any[]) => void): this;
    removeListener<K extends keyof ImapFlowEvents>(event: K, listener: (...args: ImapFlowEvents[K]) => void): this;
    removeListener(event: string | symbol, listener: (...args: any[]) => void): this;
    prependListener<K extends keyof ImapFlowEvents>(event: K, listener: (...args: ImapFlowEvents[K]) => void): this;
    prependListener(event: string | symbol, listener: (...args: any[]) => void): this;
    prependOnceListener<K extends keyof ImapFlowEvents>(event: K, listener: (...args: ImapFlowEvents[K]) => void): this;
    prependOnceListener(event: string | symbol, listener: (...args: any[]) => void): this;
    emit<K extends keyof ImapFlowEvents>(event: K, ...args: ImapFlowEvents[K]): boolean;
    emit(event: string | symbol, ...args: any[]): boolean;
}

/**
 * IMAP client class for accessing IMAP mailboxes
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class ImapFlow extends EventEmitter {
    /**
     * Current module version as a static class property
     */
    static version: string = packageInfo.version;

    /** IMAP connection options, see {@link ImapFlowOptions} */
    options: ImapFlowOptions;

    /** Instance ID for logs */
    id: string;

    /** Client identification info sent with the ID command */
    clientInfo: IdInfoObject;

    /**
     * Server identification info. Available after successful `connect()`.
     * If server does not provide identification info then this value is `null`.
     */
    serverInfo: IdInfoObject | null;

    /** Connection logger. Every level is callable, see `getLogger()` */
    log: InternalLogger;

    /** Is the connection currently encrypted or not */
    secureConnection: boolean;

    /** Port number the connection is made to */
    port: number;

    /** Hostname the connection is made to */
    host: string;

    /** Server name for SNI, or false when connecting to an IP literal */
    servername: string | false;

    /**
     * Normalized socket inactivity timeout in milliseconds
     * @internal
     */
    socketTimeout: number;

    /**
     * Log raw socket traffic in base64
     * @internal
     */
    logRaw: boolean | undefined;

    /**
     * The response parser stream
     * @internal
     */
    streamer: ImapStream;

    /**
     * Whether the reader loop is running
     * @internal
     */
    reading: boolean;

    /**
     * The socket carrying the session: `false` before connecting, `null` once closed
     * @internal
     */
    socket: ImapSocket | false | null;

    /**
     * Where outgoing bytes are written, see {@link WriteSocket}
     * @internal
     */
    writeSocket: WriteSocket | false | null;

    // In-flight throttle back-offs (see throttleWait()). Tracked as a set because more than
    // one can be pending at a time: the reader's connection-level back-off and a command
    // retrying its own throttled request. close() clears them all.
    /** @internal */
    _throttleWaits: Set<ThrottleWaitEntry>;

    // Pending rejector of the in-flight STARTTLS upgrade promise (see upgradeToSTARTTLS()).
    // Stored so emitError() can route a streamer-originated error into the upgrade's single
    // error path instead of dropping it (which could hang a verifyOnly connect()).
    /** @internal */
    _upgradeReject: ((err: Error) => void) | null;

    /** Set once `close()` has run */
    isClosed: boolean;

    /** Connection state constants */
    states: ConnectionStates;

    /** Current connection state, one of `states` */
    state: ConnectionState;

    /** @internal */
    lockCounter: number;

    /** @internal */
    tagCounter: number;
    /** @internal */
    requestTagMap: Map<string, PendingRequest>;
    /** @internal */
    requestQueue: QueuedRequest[];
    /** @internal */
    currentRequest: QueuedRequest | false;

    // Count of tagged responses whose tag was never issued by this connection. Tolerated
    // (non-conforming servers do this) but tracked, so the compatibility decision in
    // countUnknownTag() can be revisited with field data instead of guesses. Warnings are
    // emitted at the milestones below (1, 2, 4, 8, ...) so the count stays exact without
    // turning a spraying server into a log flood.
    /** @internal */
    _unknownTagCount: number;
    /** @internal */
    _nextUnknownTagWarn: number;

    /** @internal */
    writeBytesCounter: number;

    /**
     * Remaining parts of the command being written: literal data and continuations
     * @internal
     */
    commandParts: Buffer[];

    // Whether the command currently being written carries credentials. send() sets this for
    // every command before its first frame reaches the socket, and the raw traffic log reads
    // it; every write belongs to the command send() dispatched last, because trySend() keeps
    // one command in flight at a time. The initial value only covers a write before the
    // first command, which no current path performs. See write().
    /** @internal */
    rawSensitiveCommand: boolean;

    /**
     * Active IMAP capabilities. Value is either `true` for toggleable capabilities (eg. `UIDPLUS`)
     * or a number for capabilities with a value (eg. `APPENDLIMIT`)
     */
    capabilities: Map<string, boolean | number>;

    /**
     * Advertised AUTH= mechanisms, `true` for the one that was used
     * @internal
     */
    authCapabilities: Map<string, boolean>;

    /**
     * The capability list as the server sent it
     * @internal
     */
    rawCapabilities: ImapAttributeList | null | undefined;

    /** @internal */
    expectCapabilityUpdate: boolean;

    // Set true if the server sent data after the STARTTLS OK and before the TLS
    // handshake (a plaintext-injection signal). See upgradeToSTARTTLS().
    /** @internal */
    _starttlsHadTrailingData: boolean;

    /**
     * Enabled capabilities. Usually `CONDSTORE` and `UTF8=ACCEPT` if server supports these.
     */
    enabled: Set<string>;

    /**
     * Is the connection currently usable or not
     */
    usable: boolean;

    /**
     * Currently authenticated user or `false` if mailbox is not open
     * or `true` if connection was authenticated by PREAUTH
     */
    authenticated: string | boolean;

    /**
     * Currently selected mailbox or `false` if mailbox is not open
     */
    mailbox: MailboxObject | false;

    /**
     * The SELECT/EXAMINE command that opened the current mailbox, for re-selecting
     * @internal
     */
    currentSelectCommand: SelectCommand | false;

    /**
     * Is current mailbox idling (`true`) or not (`false`)
     */
    idling: boolean;

    /** Whether log entries are also emitted as 'log' events, see the `emitLogs` option */
    emitLogs: boolean;
    // ordering number for emitted logs
    /** @internal */
    lo: number;

    /** @internal */
    untaggedHandlers: { [command: string]: UntaggedHandler | null | undefined };
    /** @internal */
    sectionHandlers: { [key: string]: SectionHandler | null | undefined };

    /** @internal */
    commands: Map<string, CommandHandler>;

    /**
     * Mailboxes from the last LIST, keyed by path
     * @internal
     */
    folders: Map<string, ListResponse>;

    /** @internal */
    currentLock: MailboxLockEntry | false;
    /** @internal */
    locks: MailboxLockEntry[];

    /** @internal */
    idRequested: IdInfoObject | false;

    /** @internal */
    maxIdleTime: number | false;
    /** @internal */
    autoIdleDelay: number;

    // Wall-clock time of the last fallback poll, owned by commands/idle.ts
    /** @internal */
    _lastPollAt: number;

    // Download streams still fetching chunks. Counted, not a flag, so overlapping downloads
    // cannot clear each other's suppression of auto-IDLE.
    /** @internal */
    _openDownloads: number;
    /** @internal */
    missingIdleCommand: string;

    /** @internal */
    disableBinary: boolean;

    // Set when the server rejects a LIST RETURN option group, the auxiliary
    // SPECIAL-USE/CHILDREN return options, or the LSUB command, so later
    // listings on this connection skip what the server does not support
    /** @internal */
    skipListSubscribedArg: boolean;
    /** @internal */
    skipListStatusArgs: boolean;
    /** @internal */
    skipListAuxArgs: boolean;
    /** @internal */
    skipLsub: boolean;

    // Set when the IMAP4rev2 advertisement is not to be acted on: the caller opted
    // out (disableIMAP4rev2), or the server rejected ENABLE IMAP4REV2 while also
    // advertising IMAP4rev1. Either way the session is IMAP4rev1, so nothing may
    // treat the advertisement as a promise of rev2 syntax such as LIST RETURN.
    // Exchange Online started advertising IMAP4rev2 this way in 2026-09: it answers
    // ENABLE IMAP4REV2 and every LIST with RETURN options with BAD, and closes the
    // connection after three rejected commands, so a LIST retry ladder that still
    // trusted the advertisement supplied the second and third
    /** @internal */
    skipRev2: boolean;

    /** @internal */
    _streamerErrorHandler: ((err: ImapFlowError) => void) | null;

    // Has the `connect` method already been called
    /** @internal */
    _connectCalled: boolean;

    // State that is only set later in the connection's life
    /**
     * Whether a STARTTLS upgrade is in progress
     * @internal
     */
    declare upgrading: boolean | undefined;
    /**
     * Settles the pending `connect()` promise, see `beginSession()`
     * @internal
     */
    declare initialResolve: (() => void) | false | undefined;
    /** @internal */
    declare initialReject: ((err: Error) => void) | false | undefined;
    /**
     * Breaks an active IDLE before the next command, installed by commands/idle.ts
     * @internal
     */
    declare preCheck: (() => Promise<void>) | false | undefined;
    /**
     * Token of the IDLE or polling session that owns `idling`, see commands/idle.ts
     * @internal
     */
    declare _idleSession: object | null | undefined;
    /** The personal namespace, from the NAMESPACE command */
    declare namespace: NamespaceObject | undefined;
    /** Every namespace the server reported */
    declare namespaces: NamespacesObject | undefined;
    /** Human readable text of the server greeting */
    declare greeting: string | undefined;
    /** Reason text of the server's BYE response, if the server closed the session */
    declare byeReason: string | undefined;
    /** Negotiated TLS session details, `false` for a cleartext connection */
    declare tls: TlsInfo | false | undefined;
    /**
     * The DEFLATE stream for outgoing data once COMPRESS is active
     * @internal
     */
    declare _deflate: zlib.DeflateRaw | null | undefined;
    /**
     * The INFLATE stream for incoming data once COMPRESS is active
     * @internal
     */
    declare _inflate: zlib.InflateRaw | null | undefined;
    /** @internal */
    declare connectTimeout: NodeJS.Timeout | null | undefined;
    /** @internal */
    declare greetingTimeout: NodeJS.Timeout | null | undefined;
    /** @internal */
    declare upgradeTimeout: NodeJS.Timeout | null | undefined;
    /** @internal */
    declare idleStartTimer: NodeJS.Timeout | null | undefined;
    /** @internal */
    declare socketReadable: (() => void) | undefined;
    /** @internal */
    declare _connectErrorHandler: ((err: Error) => void) | null | undefined;
    /** @internal */
    declare _socketError: ((err: Error) => void) | null | undefined;
    /** @internal */
    declare _socketClose: (() => void) | null | undefined;
    /** @internal */
    declare _socketEnd: (() => void) | null | undefined;
    /** @internal */
    declare _socketTimeout: (() => void) | null | undefined;
    /** @internal */
    declare processingLock: boolean | undefined;
    /**
     * Mailbox listing collected by a `verifyOnly` connection with `includeMailboxes`
     * @internal
     */
    declare _mailboxList: ListResponse[] | undefined;

    constructor(options?: ImapFlowOptions | undefined) {
        super({ captureRejections: true });

        this.options = options || {};

        this.id = this.options.id || this.getRandomId();

        this.clientInfo = Object.assign(
            {
                name: packageInfo.name,
                version: packageInfo.version,
                vendor: 'Postal Systems',
                'support-url': 'https://github.com/postalsys/imapflow/issues'
            },
            this.options.clientInfo || {}
        );

        // remove diacritics
        for (let key of Object.keys(this.clientInfo)) {
            if (typeof this.clientInfo[key] === 'string') {
                this.clientInfo[key] = this.clientInfo[key].normalize('NFD').replace(/\p{Diacritic}/gu, '');
            }
        }

        this.serverInfo = null; //updated by ID

        this.log = this.getLogger();

        this.secureConnection = !!this.options.secure;

        // 993 is IMAPS, 143 is IMAP over cleartext/STARTTLS. The non-secure default used to be 110,
        // which is POP3 - a client created without an explicit port could never connect.
        this.port = Number(this.options.port) || (this.secureConnection ? 993 : 143);
        this.host = this.options.host || 'localhost';
        this.servername = this.options.servername ? this.options.servername : !net.isIP(this.host) ? this.host : false;

        if (typeof this.options.secure === 'undefined' && this.port === 993) {
            // if secure option is not set but port is 993, then default to secure
            this.secureConnection = true;
        }

        // Normalized once so direct TLS, cleartext, proxied and STARTTLS-upgraded transports
        // cannot end up with different inactivity watchdogs. As documented, 0 (and any other
        // falsy or invalid value) means "use the default", not "disable".
        this.socketTimeout = Number(this.options.socketTimeout) || SOCKET_TIMEOUT;

        this.logRaw = this.options.logRaw;
        this.streamer = new ImapStream({
            logger: this.log,
            cid: this.id,
            logRaw: this.logRaw,
            secureConnection: this.secureConnection,
            maxLineLength: this.options.maxLineLength,
            maxLiteralSize: this.options.maxLiteralSize,
            maxResponseSize: this.options.maxResponseSize
        });

        this.reading = false;
        this.socket = false;
        this.writeSocket = false;

        this._throttleWaits = new Set();

        this._upgradeReject = null;

        this.isClosed = false;

        this.states = states;
        this.state = this.states.NOT_AUTHENTICATED;

        this.lockCounter = 0;

        this.tagCounter = 0;
        this.requestTagMap = new Map();
        this.requestQueue = [];
        this.currentRequest = false;

        this._unknownTagCount = 0;
        this._nextUnknownTagWarn = 1;

        this.writeBytesCounter = 0;

        this.commandParts = [];

        this.rawSensitiveCommand = true;

        this.capabilities = new Map();
        this.authCapabilities = new Map();

        this.rawCapabilities = null;

        this.expectCapabilityUpdate = false; // force CAPABILITY after LOGIN

        this._starttlsHadTrailingData = false;

        this.enabled = new Set();

        this.usable = false;

        this.authenticated = false;

        this.mailbox = false;
        this.currentSelectCommand = false;

        this.idling = false;

        this.emitLogs = !!this.options.emitLogs;
        this.lo = 0;

        this.untaggedHandlers = {};
        this.sectionHandlers = {};

        this.commands = imapCommands;

        this.folders = new Map();

        this.currentLock = false;
        this.locks = [];

        this.idRequested = false;

        this.maxIdleTime = this.options.maxIdleTime || false;
        this.autoIdleDelay = normalizeAutoIdleDelay(this.options.autoIdleDelay, this.socketTimeout, this.log, this.id);

        this._lastPollAt = 0;

        this._openDownloads = 0;
        this.missingIdleCommand = (this.options.missingIdleCommand || '').toString().toUpperCase().trim() || 'NOOP';

        this.disableBinary = !!this.options.disableBinary;

        this.skipListSubscribedArg = false;
        this.skipListStatusArgs = false;
        this.skipListAuxArgs = false;
        this.skipLsub = false;
        this.skipRev2 = !!this.options.disableIMAP4rev2;

        // Named error handler for proper cleanup. Certain error codes represent
        // expected socket/network issues (buffer exhaustion, connection reset, broken pipe,
        // timeout, unreachable host) that just need a silent connection close rather
        // than emitting an error event to the caller.
        this._streamerErrorHandler = (err: ImapFlowError) => {
            if (['Z_BUF_ERROR', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH'].includes(err.code as string)) {
                this.closeAfter();
                return;
            }

            this.log.error({ err, cid: this.id });
            this.emitError(err);
        };
        this.streamer.on('error', this._streamerErrorHandler);

        this._connectCalled = false;
    }

    /** @internal */
    emitError(err: ImapFlowError | null | undefined): void {
        if (!err) {
            return;
        }
        err._connId = err._connId || this.id;

        // During a STARTTLS handshake the upgrade owns the single error path (its settle()
        // helper). Route the error there so a streamer-originated failure is surfaced with its
        // real code (instead of a generic ClosedAfterConnect*) and cannot hang a verifyOnly
        // connect() waiting on a 'close' that never rejects. Fall back to closing if the upgrade
        // has no pending rejector.
        if (this.upgrading) {
            let reject = this._upgradeReject;
            this._upgradeReject = null;
            if (typeof reject === 'function') {
                // settle() clears the upgrade timer and flags, and closes the connection
                reject(err);
                return;
            }
            this.upgrading = false;
            this.closeAfter();
            return;
        }

        // While the initial connect promise is still pending it owns error reporting:
        // reject it once instead of emitting a duplicate 'error' event (which would also
        // throw if the caller has not attached an 'error' listener yet).
        if (typeof this.initialReject === 'function') {
            let reject = this.initialReject;
            this.initialResolve = false;
            this.initialReject = false;
            this.closeAfter();
            reject(err);
            return;
        }

        this.closeAfter();
        this.emit('error', err);
    }

    /** @internal */
    getRandomId(): string {
        let rid = BigInt('0x' + crypto.randomBytes(13).toString('hex')).toString(36);
        if (rid.length < 20) {
            rid = '0'.repeat(20 - rid.length) + rid;
        }
        if (rid.length > 20) {
            rid = rid.substr(0, 20);
        }
        return rid;
    }

    /** @internal */
    write(chunk: string | Buffer): void | false {
        if (!this.socket || this.socket.destroyed) {
            // do not write after connection end or logout
            throw this.createConnectionError('NoConnection', 'Socket is already closed', { rejectedFrom: 'writeNoSocket' });
        }

        if (this.state === this.states.LOGOUT) {
            // should not happen
            throw this.createConnectionError('StateLogout', 'Can not send data after logged out', { rejectedFrom: 'writeAfterLogout' });
        }

        if ((this.writeSocket as WriteSocket).destroyed) {
            this.log.error({ msg: 'Write socket destroyed', cid: this.id });
            this.close();
            return;
        }

        // Append CRLF only to the final part of a command. When sending literals,
        // commandParts holds the remaining parts (literal data, continuation); the CRLF
        // delimiter is only added when no more parts remain (the command is complete).
        let addLineBreak = !this.commandParts.length;
        let data: Buffer;
        if (typeof chunk === 'string') {
            if (addLineBreak) {
                chunk += '\r\n';
            }
            data = Buffer.from(chunk, 'binary');
        } else if (Buffer.isBuffer(chunk)) {
            if (addLineBreak) {
                data = Buffer.concat([chunk, Buffer.from('\r\n')]);
            } else {
                data = chunk;
            }
        } else {
            return false;
        }

        if (this.logRaw) {
            // Client frames of an authentication exchange carry credentials: the LOGIN
            // arguments, and for AUTHENTICATE also the continuation writes (SASL PLAIN
            // response, AUTH=LOGIN password, OAuth token payload) that bypass send(). The
            // parsed command log masks these, so the raw log must withhold them too, but
            // `data` still carries the placeholder rather than being dropped - the field is
            // part of the documented log format and consumers decode it unconditionally.
            this.log.trace({
                src: 'c',
                msg: 'write to socket',
                data: this.rawSensitiveCommand ? RAW_HIDDEN_PLACEHOLDER : data.toString('base64'),
                ...(this.rawSensitiveCommand ? { hidden: true } : {}),
                compress: !!this._deflate,
                secure: !!this.secureConnection,
                cid: this.id
            });
        }

        this.writeBytesCounter += data.length;

        (this.writeSocket as WriteSocket).write(data);
    }

    /**
     * Returns byte counters for the current connection.
     *
     * @param reset If `true` then resets the byte counters after returning the current values
     * @returns Byte counters: bytes sent to and received from the server
     */
    stats(reset?: boolean): { sent: number; received: number } {
        let result = {
            sent: this.writeBytesCounter || 0,
            received: (this.streamer && this.streamer.readBytesCounter) || 0
        };

        if (reset) {
            this.writeBytesCounter = 0;
            if (this.streamer) {
                this.streamer.readBytesCounter = 0;
            }
        }

        return result;
    }

    // Compiles and sends an IMAP command to the server. The command is compiled
    // twice: once as an array (for sending, with literal data split into parts)
    // and once as a string (for logging, with sensitive data masked).
    // When LITERAL- or LITERAL+ extensions are available, the compiler can use
    // non-synchronizing literals to avoid waiting for server "+" continuation.
    /** @internal */
    async send(data: QueuedRequest): Promise<void> {
        if (this.state === this.states.LOGOUT) {
            // already logged out
            if (data.tag) {
                let request = this.requestTagMap.get(data.tag);
                if (request) {
                    this.requestTagMap.delete(data.tag);
                    request.reject(this.createNoConnectionError(false, { rejectedFrom: 'sendAfterLogout', command: request.command }));
                }
            }
            return;
        }

        // Classify before the first await. Every frame of this command - the command line and
        // any continuation write that follows it - belongs to it until the next send(), because
        // trySend() keeps one command in flight at a time. Reading currentRequest inside write()
        // instead would be racy: rejectCurrentRequest() can clear it while the two compiler
        // awaits below are pending, and the credential frame would then be logged in the clear.
        // Uppercased because the wire protocol is case-insensitive and exec() passes the
        // caller's spelling through unchanged. The command list covers the mechanisms whose
        // secret arrives in a continuation frame, which carries no attributes of its own; the
        // `sensitive` marker catches anything that instead puts a secret on the command line,
        // so marking an attribute is enough to keep a new command out of the raw log too.
        this.rawSensitiveCommand =
            RAW_SENSITIVE_COMMANDS.has(typeof data.command === 'string' ? data.command.toUpperCase() : '') || hasSensitiveAttribute(data.attributes);

        // Compile with asArray=true: splits output into parts for literal handling.
        // First part is the command text up to the first literal, remaining parts
        // are stored in this.commandParts and sent after server "+" continuations.
        let compiled = await compiler(data, {
            asArray: true,
            // LITERAL- is part of base IMAP4rev2
            literalMinus: hasCapability(this, 'LITERAL-') || this.capabilities.has('LITERAL+')
        });
        this.commandParts = compiled;

        // Compile again for logging with isLogging=true: masks sensitive values
        // like passwords while producing a human-readable command string
        let logCompiled = await compiler(data, {
            isLogging: true
        });

        /* c8 ignore next */ // send() is always invoked with a request object carrying options, so the {} fallback is unreachable
        let options = data.options || {};

        this.log.debug({ src: 'c', msg: logCompiled.toString(), cid: this.id, comment: options.comment });

        // Send the first part (command text). If there are literal parts,
        // the server will respond with "+" continuations and reader() will
        // send each remaining part from this.commandParts.
        this.write(this.commandParts.shift() as Buffer);

        // The command is on the wire now. Tagged-response correlation requires this, so a server
        // that guesses the next (sequential) tag cannot settle a command during the window between
        // it becoming current and actually being written.
        if (this.currentRequest && this.currentRequest.tag === data.tag) {
            this.currentRequest.sent = true;
        }

        if (typeof options.onSend === 'function') {
            // The command is already on the wire, so a throwing onSend callback must not
            // reach trySend()'s catch - that would reject the request and dispatch the
            // next command into the server's pending state for this one.
            try {
                options.onSend();
            } catch (err) {
                this.log.warn({ err, cid: this.id });
            }
        }
    }

    /** @internal */
    async trySend(): Promise<void> {
        while (!this.currentRequest && this.requestQueue.length) {
            this.currentRequest = this.requestQueue.shift() as QueuedRequest;

            try {
                await this.send({
                    tag: this.currentRequest.tag,
                    command: this.currentRequest.command,
                    attributes: this.currentRequest.attributes,
                    options: this.currentRequest.options
                });
                return;
            } catch (err) {
                // A failure here (most likely the compiler refusing an invalid
                // user-supplied value) belongs to the command that was being dispatched.
                // Without this the shifted request would stay currentRequest forever:
                // nothing reached the wire, so no tagged response ever clears it, and
                // every later command would queue behind it until the socket timeout.
                // Reject the failed command and keep draining the queue.
                this.commandParts = [];
                this.rejectCurrentRequest(err as Error);
            }
        }
    }

    /** @internal */
    exec(command: string, attributes?: ImapCompileNode[] | false | undefined, options?: ExecOptions | undefined): Promise<ExecResponse> {
        if (this.state === this.states.LOGOUT || this.isClosed) {
            return guardedReject(this.createNoConnectionError(false, { rejectedFrom: 'execClosed', command }));
        }

        if (!this.socket || this.socket.destroyed) {
            return guardedReject(this.createConnectionError('EConnectionClosed', 'Connection closed', { rejectedFrom: 'execNoSocket', command }));
        }

        let tag = (++this.tagCounter).toString(16).toUpperCase();

        let execOptions: ExecOptions = options || {};

        // Guarded: close() rejects this request synchronously, possibly before the caller has
        // attached its handler. See guardedPromise().
        return guardedPromise<ExecResponse>((resolve, reject) => {
            this.requestTagMap.set(tag, { command, attributes, options: execOptions, resolve, reject });
            this.requestQueue.push({ tag, command, attributes, options: execOptions });
            // trySend() settles dispatch failures itself, by rejecting the affected
            // command through requestTagMap; this catch exists only so a throw from the
            // dispatch machinery itself can never surface as a floating rejection.
            this.trySend().catch(err => logConnectionError(this, 'Failed to dispatch command', err));
        });
    }

    // Resolves an untagged server response to the keyword it is dispatched on. IMAP untagged
    // responses come in two forms:
    //   * CAPABILITY ...       (keyword as command)
    //   * 42 FETCH (...)       (numeric prefix + keyword)
    // For numeric-prefixed responses the keyword sits in the first attribute, because `command`
    // holds the sequence number. Also used for logging, so a failure reports FETCH rather than
    // the message number that happened to precede it.
    /** @internal */
    normalizeUntaggedCommand(command: string, attributes?: ImapAttributeList | undefined): string {
        if (/^[0-9]+$/.test(command)) {
            let type =
                attributes && attributes.length && typeof (attributes[0] as ImapAttributeNode).value === 'string'
                    ? ((attributes[0] as ImapAttributeNode).value as string).toUpperCase()
                    : false;
            if (type) {
                command = type;
            }
        }

        return command.toUpperCase().trim();
    }

    // Handler priority: command-specific handlers (registered per exec() call) take
    // precedence over global handlers (registered on the connection).
    /** @internal */
    getUntaggedHandler(command: string, attributes?: ImapAttributeList | undefined): UntaggedHandler | undefined {
        command = this.normalizeUntaggedCommand(command, attributes);
        // Check command-specific handler first (registered in exec() options.untagged)
        if (this.currentRequest && this.currentRequest.options && this.currentRequest.options.untagged && this.currentRequest.options.untagged[command]) {
            return this.currentRequest.options.untagged[command];
        }

        // Fall back to global handler (e.g., for CAPABILITY, BYE, etc.)
        let handler = this.untaggedHandlers[command];
        if (handler) {
            return handler;
        }
    }

    /** @internal */
    getSectionHandler(key: string): SectionHandler | undefined {
        if (this.sectionHandlers[key]) {
            return this.sectionHandlers[key];
        }
    }

    // Releases a readable stream item exactly once. The item's `next` callback is the parser's
    // backpressure token: until it is called, ImapStream stops feeding the connection. Every
    // path out of response handling - success, handled error, or unexpected throw - has to go
    // through here, otherwise the parser stalls permanently.
    /** @internal */
    releaseStreamData(data: ImapStreamItem | null | undefined): void {
        if (!data || data.released) {
            return;
        }
        data.released = true;
        if (typeof data.next === 'function') {
            data.next();
        }
    }

    // Records a tagged response whose tag was never issued by this connection. ImapFlow talks
    // to a wide range of non-conforming servers, so this is tolerated rather than terminal, but
    // it must not pass silently. Warnings are emitted for the first occurrence and then at
    // powers of two so a server spraying stray tagged lines cannot flood the log, while the
    // counter itself stays exact and is reported when the connection closes.
    /** @internal */
    countUnknownTag(tag: string): void {
        if (this.isClosed) {
            // teardown crossover, not a server compatibility signal
            return;
        }

        this._unknownTagCount++;
        if (this._unknownTagCount === this._nextUnknownTagWarn) {
            this._nextUnknownTagWarn *= 2;
            this.log.warn({
                msg: 'Tagged response for an unknown tag',
                tag,
                unknownTagCount: this._unknownTagCount,
                cid: this.id
            });
        }
    }

    // Terminally fails the connection on a protocol violation: stop parsing, then report. Both
    // steps are explicit here rather than destroying the parser *with* the error and relying on
    // its error listener to report, so the reporting path does not depend on teardown ordering or
    // on the streamer error handler's suppression list.
    /** @internal */
    failProtocol(err: ImapFlowError): void {
        if (this.streamer && !this.streamer.destroyed) {
            // Destroyed without an error: nothing after a protocol violation may reach
            // application state, and emitError() below owns reporting.
            this.streamer.destroy();
        }
        this.emitError(err);
    }

    // Rejects the in-flight request, if any, exactly once. Used when response handling fails in
    // a way that leaves the command's outcome unknown.
    /** @internal */
    rejectCurrentRequest(err: Error): void {
        if (!this.currentRequest) {
            return;
        }
        let tag = this.currentRequest.tag;
        this.currentRequest = false;
        let request = this.requestTagMap.get(tag);
        if (request) {
            this.requestTagMap.delete(tag);
            request.reject(err);
        }
    }

    /**
     * Waits out a throttle back-off.
     *
     * The delay is capped at MAX_THROTTLE_DELAY because it can come straight from a server hint
     * (a Microsoft 365 "Suggested Backoff Time", say) and an uncapped hint would park the caller
     * for weeks. The timer is unref'd and tracked so it can never outlive the client: a bare
     * setTimeout here keeps a short-lived process alive for the full delay after close(), and
     * leaves the caller waiting on a connection that is already gone.
     *
     * @param delay - Requested delay in milliseconds.
     * @returns True if close() aborted the wait, false on normal expiry.
     * @internal
     */
    async throttleWait(delay: number): Promise<boolean> {
        delay = Math.min(Math.max(Number(delay) || 0, 0), MAX_THROTTLE_DELAY);

        return await new Promise<boolean>(resolve => {
            let entry: ThrottleWaitEntry = { resolve };
            entry.timer = setTimeout(() => {
                this._throttleWaits.delete(entry);
                resolve(false);
            }, delay);
            unrefTimer(entry.timer);
            this._throttleWaits.add(entry);
        });
    }

    /** @internal */
    async reader(): Promise<void> {
        let data: ImapStreamItem | null;
        let processedCount = 0;
        while ((data = this.streamer.read()) !== null) {
            let keepReading;

            try {
                keepReading = await this.handleResponse(data);
            } catch (err) {
                // Response handling past the parse step (log compilation, response shape
                // assumptions, an untagged handler bug) must never throw out of this loop: the
                // parser would keep waiting on its backpressure callback forever, which is a
                // silent permanent hang. Fail closed instead.
                keepReading = false;
                let error: ImapFlowError = new Error('Failed to process server response');
                error.code = 'ResponseProcessingFailed';
                error._err = err as Error;
                this.log.error({ msg: 'Failed to process server response', err, cid: this.id });
                this.rejectCurrentRequest(error);
                this.failProtocol(error);
            } finally {
                this.releaseStreamData(data);
            }

            if (!keepReading) {
                return;
            }

            // Yield to event loop every 10 processed messages to prevent CPU blocking
            processedCount++;
            if (processedCount % 10 === 0) {
                await new Promise(resolve => setImmediate(resolve));
            }
        }
    }

    /**
     * Fails the in-flight command when a line that could not be parsed was addressed to its tag.
     * Only the leading tag is read from the raw payload - the rest of the line is by definition
     * not trustworthy - and only the command that is actually on the wire may be settled this way,
     * the same invariant the parsed tagged-response path enforces.
     *
     * @param payload - Raw bytes of the line that failed to parse.
     * @param parserError - The error the parser raised.
     * @internal
     */
    rejectUnparsedCompletion(payload: Buffer, parserError: ImapFlowError): void {
        if (!this.currentRequest || !this.currentRequest.sent) {
            return;
        }

        // Prefer the tag the parser had already extracted before it failed - it went
        // through the same leading-NUL workaround as every parsed response. Fall back
        // to the raw bytes for lines whose tag itself was unparseable: skip the NUL
        // padding buggy servers prepend and stop at the first byte a tag cannot contain.
        let tag: string | false | null | undefined = parserError && parserError.parsedTag;
        if (!tag) {
            let match = payload.toString('latin1', 0, 64).match(/^\0*([^\s\x00-\x1f\x7f]+)/);
            tag = match && match[1];
        }
        if (!tag || tag !== this.currentRequest.tag) {
            return;
        }

        let err: ImapFlowError = new Error('Failed to parse the server response for this command');
        err.code = parserError.code || 'ParserError';
        err.parserError = parserError;
        this.rejectCurrentRequest(err);

        this.trySend().catch(sendErr => logConnectionError(this, 'Failed to dispatch command', sendErr));
    }

    /**
     * Handles a single parsed server response: telemetry, continuation requests, response-code
     * section handlers, untagged handlers and tagged command completion.
     *
     * @param data - Readable item from the parser stream.
     * @returns `true` to keep reading, `false` to stop (connection is failing).
     * @internal
     */
    async handleResponse(data: ImapStreamItem): Promise<boolean> {
        let parsed: ImapResponse;

        try {
            parsed = await parser(data.payload, { literals: data.literals });
        } catch (err) {
            // can not make sense of this. The payload can be up to the configured line
            // cap (1GB by default), so log only a bounded prefix: a server looping
            // unparseable garbage would otherwise turn this error log into a disk filler.
            this.log.error({ src: 's', msg: data.payload.toString('latin1', 0, 1024), payloadBytes: data.payload.length, err, cid: this.id });
            // An unparseable untagged line is junk that can be skipped, but the line may
            // have been the in-flight command's tagged completion. Dropping that one
            // silently strands the command: currentRequest is never cleared, so trySend()
            // stops dispatching and every later command queues behind it until the socket
            // timeout fires. The tag is recovered from the raw bytes (a tag is
            // ASTRING-CHAR only, so it survives whatever made the rest unparseable) and
            // the command is failed with the parser error instead of hanging.
            this.rejectUnparsedCompletion(data.payload, err as ImapFlowError);
            return true;
        }

        if (parsed.tag && !['*', '+'].includes(parsed.tag) && parsed.command) {
            let payload: { response: string; code?: string | undefined } = { response: parsed.command };

            if (
                parsed.attributes &&
                parsed.attributes[0] &&
                parsed.attributes[0].section &&
                parsed.attributes[0].section[0] &&
                parsed.attributes[0].section[0].type === 'ATOM'
            ) {
                payload.code = parsed.attributes[0].section[0].value as string;
            }
            // Outside the parse try/catch on purpose: a throwing user 'response' listener
            // is not a parse failure and must not settle the in-flight command or fail the
            // connection - the same contract untagged handlers get.
            try {
                this.emit('response', payload);
            } catch (err) {
                this.log.warn({ err, cid: this.id });
            }
        }

        let logCompiled = await compiler(parsed, {
            isLogging: true
        });

        if (/^\d+$/.test(parsed.command || '') && parsed.attributes && parsed.attributes[0] && parsed.attributes[0].value === 'FETCH') {
            // too many FETCH responses, might want to filter these out
            this.log.trace({ src: 's', msg: logCompiled.toString(), cid: this.id, nullBytesRemoved: parsed.nullBytesRemoved });
        } else {
            this.log.debug({ src: 's', msg: logCompiled.toString(), cid: this.id, nullBytesRemoved: parsed.nullBytesRemoved });
        }

        // IMAP "+" (continuation request) handling. The server sends "+" in two cases:
        // 1. During IDLE or AUTHENTICATE, where a custom handler (onPlusTag) processes it
        // 2. During literal data transfer, where we send the next queued literal chunk
        if (parsed.tag === '+' && this.currentRequest && this.currentRequest.options && typeof this.currentRequest.options.onPlusTag === 'function') {
            try {
                await this.currentRequest.options.onPlusTag(parsed);
            } catch (err) {
                // The handler ran across an await and may have closed the connection, which
                // clears currentRequest, so the command name is read defensively
                this.log.warn({
                    msg: 'Failed to process continuation response',
                    command: this.currentRequest ? this.currentRequest.command : undefined,
                    err,
                    cid: this.id
                });
            }
            return true;
        }

        // Server acknowledged our literal size with "+", send the actual literal data
        if (parsed.tag === '+' && this.commandParts.length) {
            let content = this.commandParts.shift() as Buffer;
            // A write() failure here (e.g. socket closed mid-command) must not fail the whole
            // connection; the command's own tagged response or the close path reports it.
            try {
                this.write(content);
                this.log.debug({ src: 'c', msg: `(* ${content.length}B continuation *)`, cid: this.id });
            } catch (err) {
                logConnectionError(this, 'Failed to send literal continuation', err as ImapFlowError);
            }
            return true;
        }

        let section = parsed.attributes && parsed.attributes.length && parsed.attributes[0] && !parsed.attributes[0].value && parsed.attributes[0].section;
        // section[0] can be a parsed NIL (null), e.g. from a "[NIL]" response code - the
        // dereference must be guarded or one such line tears down the whole connection
        if (section && section.length && section[0] && section[0].type === 'ATOM' && typeof section[0].value === 'string') {
            let sectionKey = section[0].value.toUpperCase().trim();
            let sectionHandler = this.getSectionHandler(sectionKey);
            if (sectionHandler) {
                try {
                    await sectionHandler(section.slice(1));
                } catch (err) {
                    this.log.warn({ msg: 'Failed to process response section', section: sectionKey, err, cid: this.id });
                }
            }
        }

        if (parsed.tag === '*' && parsed.command) {
            let untaggedHandler = this.getUntaggedHandler(parsed.command, parsed.attributes);
            if (untaggedHandler) {
                try {
                    await untaggedHandler(parsed);
                } catch (err) {
                    // Normalized only here: this runs for every untagged response, including
                    // every FETCH, and the keyword is needed only to describe a failure
                    this.log.warn({
                        msg: 'Failed to process untagged response',
                        command: this.normalizeUntaggedCommand(parsed.command, parsed.attributes),
                        err,
                        cid: this.id
                    });
                    return true;
                }
            }
        }

        // Tagged response correlation. A tagged response may only complete the command that was
        // actually written to the socket (invariant 2), so the three cases below are kept apart:
        // the active command completes, a command that has not been written yet is proof of
        // desynchronization (queued behind another command, or current but not yet on the wire),
        // and an entirely unknown tag is recorded but tolerated.
        if (parsed.tag && !['*', '+'].includes(parsed.tag)) {
            if (this.currentRequest && this.currentRequest.tag === parsed.tag && this.currentRequest.sent) {
                let request = this.requestTagMap.get(parsed.tag);
                this.requestTagMap.delete(parsed.tag);
                this.currentRequest = false;

                if (request) {
                    await this.settleRequest(request, parsed, !!data.trailingAfterLine);
                }

                // Send the next queued command only after the completed command's handler has
                // applied its own state (e.g. select.ts publishing the new mailbox), so the next
                // command cannot reach the wire against half-updated state. A failure here must
                // not propagate, or the whole connection would be failed over a send error that
                // the command's own promise already reports.
                // Note: on a rejected command the handler's catch block runs on its own microtask
                // chain, so only the success path is fully ordered.
                try {
                    await this.trySend();
                } catch (err) {
                    this.log.warn({ err, cid: this.id });
                }
            } else if (this.requestTagMap.has(parsed.tag)) {
                // The server answered a command that has not been written to the socket yet.
                // Continuing would report unsent mutations as successful and leave every later
                // response ambiguous, so reject this request and fail the connection closed.
                let request = this.requestTagMap.get(parsed.tag) as PendingRequest;
                this.requestTagMap.delete(parsed.tag);

                let err: ImapFlowError = new Error('Server sent a tagged response for a command that was not in flight');
                err.code = 'UnexpectedTag';
                err.details = {
                    received: parsed.tag,
                    expected: this.currentRequest ? this.currentRequest.tag : null
                };

                this.log.error({ msg: 'Protocol desynchronization', err, cid: this.id });
                request.reject(err);
                this.failProtocol(err);
                return false;
            } else {
                this.countUnknownTag(parsed.tag);
            }
        }

        return true;
    }

    /**
     * Settles a request with its tagged completion response.
     *
     * On success the returned promise stays pending until the command handler calls `next()` on
     * the response, which is what orders state application before the next queued command is
     * dispatched. A command handler must therefore always release its own response before
     * awaiting another command on the same connection.
     *
     * @param request - Pending request entry (resolve/reject and the compiled command).
     * @param parsed - Parsed tagged response.
     * @param hasTrailingData - Whether more input was already buffered after this line.
     * @internal
     */
    async settleRequest(request: PendingRequest, parsed: ImapResponse, hasTrailingData: boolean): Promise<void> {
        switch ((parsed.command || '').toUpperCase()) {
            case 'OK':
            case 'BYE':
                // hasTrailingData is forwarded so STARTTLS can detect a plaintext
                // injection (data buffered after the tagged OK, before the handshake).
                await new Promise<void>(resolve => request.resolve({ response: parsed, next: resolve, hasTrailingData }));
                break;

            case 'NO':
            case 'BAD': {
                let txt =
                    parsed.attributes &&
                    parsed.attributes
                        .filter(val => (val as ImapAttributeNode).type === 'TEXT')
                        .map(val => (val as { value: string }).value.trim())
                        .join(' ');

                let err: ImapFlowError = new Error('Command failed');
                err.response = parsed;
                err.responseStatus = (parsed.command as string).toUpperCase();

                try {
                    err.executedCommand =
                        parsed.tag +
                        (
                            await compiler(request, {
                                isLogging: true
                            })
                        ).toString();
                } catch {
                    // ignore
                }

                if (txt) {
                    err.responseText = txt;

                    if (err.responseStatus === 'NO' && txt.includes('Some of the requested messages no longer exist')) {
                        // Treat as successful response
                        // Kept at warn: the caller is handed fewer messages than it asked for and
                        // is told nothing else about it, so this entry is the only record that
                        // the response was truncated.
                        this.log.warn({ msg: 'Partial FETCH response', cid: this.id, err });
                        await new Promise<void>(resolve => request.resolve({ response: parsed, next: resolve }));
                        break;
                    }

                    let throttleDelay: number | false = false;

                    // MS365 throttling detection: Office 365 returns BAD with a human-readable
                    // backoff time when rate limits are hit. Parse the delay from the response text.
                    // Example: "tag BAD Request is throttled. Suggested Backoff Time: 92415 milliseconds"
                    if (/Request is throttled/i.test(txt) && /Backoff Time/i.test(txt)) {
                        let throttlingMatch = txt.match(/Backoff Time[:=\s]+(\d+)/i);
                        if (throttlingMatch && throttlingMatch[1] && !isNaN(throttlingMatch[1] as unknown as number)) {
                            throttleDelay = Number(throttlingMatch[1]);
                        }
                    }

                    // Wait and return a throttling error
                    if (throttleDelay) {
                        err.code = 'ETHROTTLE';
                        err.throttleReset = throttleDelay;

                        // The server-suggested delay can be very large, so throttleWait() caps it
                        let delayResponse = Math.min(throttleDelay, MAX_THROTTLE_DELAY);

                        this.log.warn({ msg: 'Throttling detected', cid: this.id, throttleDelay, delayResponse, err });

                        let aborted = await this.throttleWait(delayResponse);

                        if (aborted) {
                            // Connection closed during back-off: reject promptly with a
                            // connection error (carrying any server BYE reason) instead of
                            // waiting out the throttle delay.
                            request.reject(this.createNoConnectionError(this.byeReason, { rejectedFrom: 'throttleAbort', command: request.command }));
                            break;
                        }
                    }
                }

                request.reject(err);
                break;
            }

            default: {
                let err: ImapFlowError = new Error('Invalid server response');
                err.code = 'InvalidResponse';
                err.response = parsed;
                request.reject(err);
                break;
            }
        }
    }

    /** @internal */
    setEventHandlers(): void {
        // Bind the 'readable' event to kick off the reader loop.
        // The `this.reading` flag acts as a concurrency guard: if reader()
        // is already running, new 'readable' events are ignored. The reader
        // loop will keep draining data until the stream returns null.
        const onReadable = () => {
            if (!this.reading) {
                this.reading = true;
                this.reader()
                    .catch(err => this.log.error({ err, cid: this.id }))
                    .finally(() => {
                        this.reading = false;
                        // A 'readable' event that fired while the loop was winding down was
                        // ignored by the guard above. Node emits the event on the next tick,
                        // after this handler has run, but a runtime that implements nextTick
                        // as a microtask (Cloudflare Workers) emits it before, and the response
                        // the parser had pushed in the meantime would then sit unread until the
                        // next chunk arrives - or, for the last response of an exchange, until
                        // the socket times out. Anything already buffered is picked up here.
                        if (this.streamer && !this.streamer.destroyed && this.streamer.readableLength > 0) {
                            onReadable();
                        }
                    });
            }
        };
        this.socketReadable = onReadable;

        this.streamer.on('readable', onReadable);
    }

    /**
     * Applies the transport options every established application socket needs: TCP keepalive and
     * the inactivity watchdog. Called for direct TLS, cleartext, proxied and STARTTLS-upgraded
     * sockets, so the watchdog cannot silently differ between transports (a STARTTLS session used
     * to end up with no armed timer at all).
     *
     * @param socket - The socket that now carries the IMAP session.
     * @internal
     */
    configureSocket(socket: ImapSocket | false | null | undefined): void {
        /* c8 ignore next 3 */ // defensive: connect() only calls this with an established socket
        if (!socket) {
            return;
        }

        if (typeof socket.setKeepAlive === 'function') {
            socket.setKeepAlive(true, 5 * 1000);
        }

        if (typeof socket.setTimeout === 'function') {
            socket.setTimeout(this.socketTimeout);
        }
    }

    /** @internal */
    setSocketHandlers(): void {
        // Clear any existing handlers first to prevent duplicates
        this.clearSocketHandlers();

        this._socketError =
            this._socketError ||
            ((err: Error) => {
                this.log.error({ err, cid: this.id });
                this.emitError(err);
            });
        this._socketClose = this._socketClose || (() => this.close());
        this._socketEnd = this._socketEnd || (() => this.close());

        /**
         * Socket timeout event handler.
         *
         * A quiet socket is only a dead connection when something was supposed to be talking. An
         * idling session, a download whose consumer stopped draining, and a held mailbox lock
         * whose owner is busy between commands are all expected to go quiet, so the handler keeps
         * such a connection alive with a NOOP instead of tearing it down. An in-flight command is
         * the opposite: its reply is overdue, a recovery NOOP would only queue up behind it and
         * never reach the wire, so the timeout is reported as an error. The IDLE command itself is
         * the one exception - it stays in flight for as long as idling lasts, and run() breaks it
         * through preCheck() before the NOOP is dispatched.
         *
         * IDLE is not restarted here: run() re-arms auto-IDLE once the NOOP settles, and
         * autoidle() knows whether the connection is actually free for IDLE - an open download or
         * a held lock keeps just the keepalive, and with disableAutoIdle nothing restarts at all.
         * If the server is dead the NOOP never settles, and the next timeout fires with the NOOP
         * as the stuck in-flight command, which lands in the error branch below.
         *
         * Emits the error event if the connection cannot be recovered
         */
        this._socketTimeout =
            this._socketTimeout ||
            (() => {
                const err: ImapFlowError = new Error('Socket timeout');
                err.code = 'ETIMEOUT';

                const quietExpected = this.idling || this._openDownloads || this.currentLock;
                const commandStuck = this.currentRequest && !(this.idling && this.currentRequest.command === 'IDLE');

                if (quietExpected && !commandStuck) {
                    if (!this.usable || !this.socket || this.socket.destroyed) {
                        this.emitError(err);
                        return;
                    }
                    this.run('NOOP').catch(err => {
                        this.log.warn({ msg: 'Connection recovery failed after timeout', err, cid: this.id });
                        if (!this.isClosed) {
                            this.close();
                        }
                    });
                } else {
                    this.log.debug({ msg: 'Socket timeout', cid: this.id });
                    this.emitError(err);
                }
            });

        const socket = this.socket as ImapSocket;
        socket.once('error', this._socketError);
        socket.once('close', this._socketClose);
        socket.once('end', this._socketEnd);

        socket.on('tlsClientError', this._socketError);
        socket.on('timeout', this._socketTimeout);

        if (this.writeSocket && this.writeSocket !== this.socket) {
            this.writeSocket.on('error', this._socketError);
        }
    }

    /** @internal */
    clearSocketHandlers(): void {
        if (!this.socket) {
            return;
        }

        // Remove temporary connection error handler if still present
        if (this._connectErrorHandler) {
            this.socket.removeListener('error', this._connectErrorHandler);
            this._connectErrorHandler = null;
        }

        if (this._socketError) {
            this.socket.removeListener('error', this._socketError);
            this.socket.removeListener('tlsClientError', this._socketError);
            if (this.writeSocket && this.writeSocket !== this.socket) {
                this.writeSocket.removeListener('error', this._socketError);
            }
        }
        if (this._socketTimeout) {
            this.socket.removeListener('timeout', this._socketTimeout);
        }
        if (this._socketClose) {
            this.socket.removeListener('close', this._socketClose);
        }
        if (this._socketEnd) {
            this.socket.removeListener('end', this._socketEnd);
        }
    }

    /** @internal */
    async startSession(): Promise<void> {
        await this.run('CAPABILITY');

        if (this.capabilities.has('ID')) {
            this.idRequested = await this.run('ID', this.clientInfo);
        }

        await this.upgradeToSTARTTLS();

        await this.authenticate();

        if ((!this.idRequested || Object.keys(this.idRequested).length < 2) && this.capabilities.has('ID')) {
            // re-request ID after LOGIN
            this.idRequested = await this.run('ID', this.clientInfo);
        }

        // Make sure we have namespace set. This should also throw if Exchange actually failed authentication
        let nsResponse = await this.run('NAMESPACE');
        if (nsResponse && nsResponse.error && nsResponse.status === 'BAD' && /User is authenticated but not connected/i.test(nsResponse.text)) {
            // Not a NAMESPACE failure but authentication failure, so report as
            this.authenticated = false;
            let err = new AuthenticationFailure('Authentication failed');
            err.response = nsResponse.text;
            throw err;
        }

        if (this.options.verifyOnly) {
            // List all folders and logout
            if (this.options.includeMailboxes) {
                this._mailboxList = await this.list();
            }
            return await this.logout();
        }

        // try to use compression (if supported)
        if (!this.options.disableCompression) {
            await this.compress();
        }

        if (!this.options.disableAutoEnable) {
            await this.autoEnable();
        }

        this.usable = true;
    }

    // Enable extensions if possible. IMAP4rev2 must be enabled explicitly on
    // servers that advertise both rev1 and rev2 (RFC 9051 Appendix A); a single
    // ENABLE call is used so the enabled set is built in one round trip.
    /** @internal */
    async autoEnable(): Promise<void> {
        let enableList = ['CONDSTORE', 'UTF8=ACCEPT'].concat(this.options.qresync ? 'QRESYNC' : []).concat(this.skipRev2 ? [] : 'IMAP4rev2');
        let enableResult = await this.run('ENABLE', enableList);
        if (enableResult === false && enableList.includes('IMAP4rev2')) {
            if (this.capabilities.has('IMAP4rev2') && !isRev2Active(this)) {
                // The one command that would have made this a rev2 session was
                // rejected, so it stays an IMAP4rev1 session (RFC 9051 Appendix A)
                // with an advertisement the server does not implement - see skipRev2
                this.skipRev2 = true;
            }
            // RFC 5161 requires servers to ignore unknown ENABLE arguments, but a
            // broken implementation may reject the whole command over IMAP4rev2 -
            // retry without it so CONDSTORE/QRESYNC are not lost as collateral
            await this.run(
                'ENABLE',
                enableList.filter(extension => extension !== 'IMAP4rev2')
            );
        }
    }

    /** @internal */
    async compress(): Promise<void> {
        if (!(await this.run('COMPRESS'))) {
            return; // was not able to negotiate compression
        }

        // Set up DEFLATE compression (RFC 4978). After COMPRESS is negotiated,
        // all data in both directions is wrapped in a zlib DEFLATE stream.
        // The incoming pipeline becomes: socket -> inflate -> streamer (parser).
        // The outgoing pipeline uses a manual pump (see readNext below) instead
        // of a normal pipe, because we need to flush after every IMAP command
        // to ensure the server receives complete commands promptly.
        this._deflate = zlib.createDeflateRaw({
            windowBits: 15,
            level: zlib.constants.Z_DEFAULT_COMPRESSION, // Use default compression level (6)
            memLevel: 8, // Memory usage level (8 is default)
            strategy: zlib.constants.Z_DEFAULT_STRATEGY,
            chunkSize: 16 * 1024 // Process in 16KB chunks to prevent CPU blocking
        });
        this._inflate = zlib.createInflateRaw({
            chunkSize: 16 * 1024 // Process in 16KB chunks to prevent CPU blocking
        });

        const socket = this.socket as ImapSocket;

        // Reroute incoming data through inflate: socket -> inflate -> streamer.
        // The streamer's compress flag tells it to expect deflated framing.
        socket.unpipe(this.streamer);
        this.streamer.compress = true;
        socket.pipe(this._inflate).pipe(this.streamer);
        this._inflate.on('error', err => {
            // Only forward into the streamer while it is alive and still has an error
            // listener. After close() the streamer is destroyed and its listener removed,
            // so emitting 'error' would throw an unhandled error and crash the process.
            // (this.streamer is assigned once in the constructor and never nulled.)
            if (!this.streamer.destroyed && this.streamer.listenerCount('error')) {
                this.streamer.emit('error', err);
            }
        });

        // For outgoing data, replace the writeSocket with a PassThrough buffer.
        // We can't pipe writeSocket -> deflate -> socket directly because we need
        // to call deflate.flush() after each IMAP command to push all pending
        // compressed bytes to the server immediately (IMAP is request-response).
        const writeSocket: WriteSocket = new PassThrough({
            highWaterMark: 64 * 1024 // 64KB buffer limit to prevent excessive memory usage
        });
        this.writeSocket = writeSocket;

        /* c8 ignore start */ // destroySoon override is never invoked by ImapFlow (close() calls destroy()); kept for stream API completeness
        writeSocket.destroySoon = () => {
            try {
                if (this.socket) {
                    this.socket.destroy();
                }
                writeSocket.end();
            } catch (err) {
                this.log.error({ err, msg: 'Failed to destroy PassThrough socket', cid: this.id });
                throw err;
            }
        };
        /* c8 ignore stop */

        // The PassThrough reports its own `destroyed` state. It used to proxy the raw socket's
        // instead, which made close() skip destroying it and left the second raw-socket teardown
        // branch unreachable. write() checks the raw socket separately, so nothing depends on the
        // two states being conflated.

        // Manual pump loop: reads chunks from writeSocket, pushes them into
        // deflate, and flushes when the buffer is drained. This ensures each
        // IMAP command is fully compressed and flushed to the socket immediately.
        let reading = false;
        let processedChunks = 0;
        let readNext = async (): Promise<void> => {
            try {
                reading = true;
                processedChunks = 0;

                let chunk;
                while (this.writeSocket && (chunk = this.writeSocket.read()) !== null) {
                    if (this._deflate && this._deflate.write(chunk) === false) {
                        this._deflate.once('drain', readNext);
                        return;
                    }

                    // Yield to event loop every 100 chunks to prevent CPU blocking
                    processedChunks++;
                    /* c8 ignore next 6 */ // requires 100+ queued chunks in a single pump pass; not reproducible deterministically
                    if (processedChunks % 100 === 0) {
                        await new Promise(resolve => setImmediate(resolve));
                        if (!this.writeSocket) {
                            break;
                        }
                    }
                }

                // flush data to socket
                if (this._deflate) {
                    this._deflate.flush();
                }

                reading = false;
                /* c8 ignore next 3 */ // defensive: the pump body does not throw under normal operation
            } catch (ex) {
                this.emitError(ex as ImapFlowError);
            }
        };

        writeSocket.on('readable', () => {
            if (!reading && this.writeSocket) {
                readNext();
            }
        });
        writeSocket.on('error', err => {
            if (this.socket) {
                this.socket.emit('error', err);
            }
        });

        this._deflate.pipe(socket);
        this._deflate.on('error', err => {
            if (this.socket) {
                this.socket.emit('error', err);
            }
        });
    }

    /** @internal */
    _failSTARTTLS(): false {
        if (this.options.doSTARTTLS === true) {
            // STARTTLS configured as requirement
            let err: ImapFlowError = new Error('Server does not support STARTTLS');
            err.tlsFailed = true;
            throw err;
        }

        // Opportunistic STARTTLS. But it's not possible right now.
        // Attention: Could be a downgrade attack.
        return false;
    }

    /**
     * Tries to upgrade the connection to TLS using STARTTLS.
     * @throws if STARTTLS is required, but not possible.
     * @returns true, if the connection is now protected by TLS, either direct TLS or STARTTLS.
     */
    async upgradeToSTARTTLS(): Promise<boolean> {
        if (this.options.doSTARTTLS === true && this.options.secure === true) {
            throw new Error('Misconfiguration: Cannot set both secure=true for TLS and doSTARTTLS=true for STARTTLS.');
        }

        if (this.secureConnection) {
            // Already using direct TLS. No need for STARTTLS.
            return true;
        }

        if (this.options.doSTARTTLS === false) {
            // STARTTLS explictly disabled by config
            return false;
        }

        if (!this.capabilities.has('STARTTLS')) {
            return this._failSTARTTLS();
        }

        this.expectCapabilityUpdate = true;
        let canUpgrade = await this.run('STARTTLS');
        if (!canUpgrade) {
            return this._failSTARTTLS();
        }

        // STARTTLS plaintext-injection guard (RFC 3501 section 6.2.1): a compliant server stays
        // silent after the tagged STARTTLS OK until the TLS handshake, so any data that
        // followed the OK was injected by a MITM and must not be treated as if it arrived
        // over TLS. Two complementary best-effort checks fail closed before wrapping the
        // socket; injection that still races in afterwards corrupts the TLS handshake and
        // is rejected there instead (with a generic TLS error rather than STARTTLS_INJECTION).
        const failSTARTTLSInjection = (): ImapFlowError => {
            let err: ImapFlowError = new Error(
                'Server sent data after the STARTTLS response and before the TLS handshake; possible plaintext-injection attack'
            );
            err.code = 'STARTTLS_INJECTION';
            err.tlsFailed = true;
            this.closeAfter();
            return err;
        };

        // Check 1: the parser saw more input already buffered right after the tagged OK
        // (same TCP segment, or an already-queued chunk) - see hasTrailingData / starttls.ts.
        if (this._starttlsHadTrailingData) {
            throw failSTARTTLSInjection();
        }

        const socketPlain = this.socket as ImapSocket;

        // STARTTLS upgrade sequence: detach the plain socket from the parser,
        // wrap it in a TLS socket, then reconnect the new TLS socket to the
        // parser. The plain socket becomes the underlying transport for TLS.
        socketPlain.unpipe(this.streamer);

        // Check 2: now that the parser is detached, any bytes still buffered on the plain
        // socket arrived after the OK and were not consumed by the handshake - i.e. injected.
        // This catches late/fragmented injection that the parse-time snapshot cannot see.
        let injectedTail = typeof socketPlain.read === 'function' ? socketPlain.read() : null;
        /* c8 ignore next 3 */ // late/fragmented post-OK injection is timing-dependent and not deterministically reproducible
        if (injectedTail && injectedTail.length) {
            throw failSTARTTLSInjection();
        }
        let upgraded = await new Promise<boolean>((resolve, reject) => {
            let opts: tls.ConnectionOptions = Object.assign(
                {
                    socket: socketPlain,
                    // host is required even though the socket is already connected: without
                    // it, a connection made to an IP literal (servername=false) has its
                    // certificate verified against Node's fallback name "localhost" instead
                    // of the IP - accepting any "localhost" certificate for any IP-hosted
                    // server, and rejecting legitimate IP-SAN certificates.
                    host: this.host,
                    servername: this.servername,
                    port: this.port
                },
                this.options.tls || {}
            ) as tls.ConnectionOptions;
            this.clearSocketHandlers();

            let settled = false;

            // Single settlement path for the upgrade. Every terminal outcome - handshake
            // success, an error on the plain or the TLS socket, the upgrade timeout, an
            // explicit close(), or a streamer error routed here by emitError() - goes through
            // this helper exactly once. It owns clearing the upgrade timer, the exposed
            // rejector, the `upgrading` flag and the temporary handshake handlers, so a late
            // socket event cannot re-enter an already settled upgrade or leave state behind.
            const settle = (err?: ImapFlowError | null | undefined, result?: boolean): void => {
                if (settled) {
                    return;
                }
                settled = true;

                clearTimer(this.upgradeTimeout);
                this.upgradeTimeout = null;
                this.upgrading = false;
                this._upgradeReject = null;

                socketPlain.removeListener('error', settle);
                if (this.socket && this.socket !== socketPlain) {
                    this.socket.removeListener('error', settle);
                }

                if (err) {
                    clearTimer(this.connectTimeout);
                    // Preserve the original error, marked as a TLS failure so callers can tell
                    // an upgrade failure from an ordinary command failure.
                    err.tlsFailed = true;
                    this.closeAfter();
                    return reject(err);
                }

                resolve(result as boolean);
            };

            // Exposed so emitError() and close() can settle the upgrade through the same path.
            this._upgradeReject = settle;

            // An error on either socket settles the upgrade, so settle() is the listener itself:
            // one function, one settlement, and removeListener() in settle() needs no separate
            // handler references. A TLS handshake failure (bad certificate, protocol mismatch)
            // is emitted on the new TLS socket rather than on the plain one, so both are covered.
            socketPlain.once('error', settle);

            /* c8 ignore start */ // UPGRADE_TIMEOUT is 10s; firing it deterministically would make the test suite hang
            this.upgradeTimeout = setTimeout(() => {
                let err: ImapFlowError = new Error('Failed to upgrade connection in required time');
                err.code = 'UPGRADE_TIMEOUT';
                settle(err);
            }, UPGRADE_TIMEOUT);
            /* c8 ignore stop */

            this.upgrading = true;
            let tlsSocket: ImapSocket;
            try {
                tlsSocket = tls.connect(opts, () => {
                    try {
                        /* c8 ignore start */ // race: connection closed during the TLS handshake window
                        if (this.isClosed) {
                            return settle(this.createNoConnectionError(false, { rejectedFrom: 'tlsUpgrade' }));
                        }
                        /* c8 ignore stop */

                        // TLS handshake complete. Reconnect the now-encrypted socket
                        // to the IMAP parser stream and record the cipher details.
                        this.secureConnection = true;
                        this.streamer.secureConnection = true;
                        tlsSocket.pipe(this.streamer);
                        // Cloudflare Workers expose getCipher() but return null from it, so the
                        // result is normalized to the documented `false`
                        /* c8 ignore next */ // on Node an upgraded TLS socket always answers getCipher(), so the false fallback is unreachable
                        this.tls = (typeof tlsSocket.getCipher === 'function' && tlsSocket.getCipher()) || false;
                        if (this.tls) {
                            this.tls.authorized = tlsSocket.authorized;
                            this.log.info({
                                src: 'tls',
                                msg: 'Established TLS session',
                                cid: this.id,
                                authorized: this.tls.authorized,
                                /* c8 ignore next */ // cipher.standardName is present on modern Node, so the .name fallback rarely runs
                                algo: this.tls.standardName || this.tls.name,
                                version: this.tls.version
                            });
                        }

                        // The plain socket is now only the TLS transport: drop its superseded
                        // inactivity timer so no armed timer is left behind without a listener.
                        if (typeof socketPlain.setTimeout === 'function') {
                            socketPlain.setTimeout(0);
                        }

                        // Install the normal socket handlers only now that the handshake
                        // succeeded. Doing this during the handshake would leave both settle() and
                        // the generic _socketError on the socket; a handshake 'error' would then fire
                        // BOTH (EventEmitter clones its listener array on emit), causing a duplicate
                        // error and a possible unhandled 'error' crash. Keeping settle() as the sole
                        // listener until here guarantees a single error path for the upgrade.
                        this.setSocketHandlers();

                        // Arm the inactivity watchdog on the socket that now carries the session.
                        // Without this a STARTTLS-upgraded connection has no watchdog at all: the
                        // timer was armed on the plain socket, while the timeout listener lives on
                        // the TLS socket.
                        this.configureSocket(this.socket);

                        // settle() also removes the temporary handshake handlers
                        settle(null, true);
                        /* c8 ignore next 3 */ // defensive: the success callback body does not throw under normal operation
                    } catch (ex) {
                        this.emitError(ex as ImapFlowError);
                    }
                });
            } catch (err) {
                // tls.connect() refused the upgrade before any handshake (an option the runtime
                // does not implement, a socket it can not wrap). Settled through the same path
                // as a handshake failure, so the upgrade state and its timer are cleared and
                // the error is marked as a TLS failure rather than escaping the executor.
                settle(err as ImapFlowError);
                return;
            }
            this.socket = tlsSocket;

            // Registered after tls.connect (the TLS socket now exists). This is the ONLY
            // error listener during the handshake window; the generic handlers are installed
            // by setSocketHandlers() inside the success callback above, so a handshake error
            // has a single error path.
            tlsSocket.once('error', settle);

            this.writeSocket = tlsSocket;
        });

        if (upgraded) {
            // RFC 9051 section 6.2.1: once TLS is started the client MUST discard the
            // cached capabilities and reissue CAPABILITY, because everything learned
            // before the handshake was plaintext an active attacker could rewrite.
            // Unconditional on purpose: a server that stamps [CAPABILITY ...] on the
            // STARTTLS OK itself clears expectCapabilityUpdate, so keying the discard
            // on that flag would keep exactly the pre-TLS list an attacker controls -
            // the list that then picks the AUTH mechanism and answers LOGINDISABLED.
            this.clearCapabilities();
            await this.run('CAPABILITY');
        }

        return upgraded;
    }

    /** @internal */
    async setAuthenticationState(): Promise<void> {
        this.state = this.states.AUTHENTICATED;
        this.authenticated = true;
        if (this.expectCapabilityUpdate) {
            // update capabilities
            await this.run('CAPABILITY');
        }
    }

    /** @internal */
    async authenticate(): Promise<boolean> {
        if (this.state === this.states.LOGOUT) {
            throw new AuthenticationFailure('Already logged out');
        }

        if (this.state !== this.states.NOT_AUTHENTICATED) {
            // nothing to do here, usually happens with PREAUTH greeting
            return true;
        }

        if (!this.options.auth) {
            throw new AuthenticationFailure('Please configure the login');
        }

        this.expectCapabilityUpdate = true;

        let loginMethod = (this.options.auth.loginMethod || '').toString().trim().toUpperCase();
        if (!loginMethod && /\\|\//.test(this.options.auth.user)) {
            // Special override for MS Exchange when authenticating as some other user or non-email account
            loginMethod = 'LOGIN';
        }

        if (this.options.auth.accessToken) {
            this.authenticated = await this.run('AUTHENTICATE', this.options.auth.user, { accessToken: this.options.auth.accessToken });
        } else if (this.options.auth.pass) {
            if ((this.capabilities.has('AUTH=LOGIN') || this.capabilities.has('AUTH=PLAIN')) && loginMethod !== 'LOGIN') {
                this.authenticated = await this.run('AUTHENTICATE', this.options.auth.user, {
                    password: this.options.auth.pass,
                    loginMethod,
                    authzid: this.options.auth.authzid
                });
            } else {
                if (this.capabilities.has('LOGINDISABLED')) {
                    throw new AuthenticationFailure('Login is disabled');
                }
                this.authenticated = await this.run('LOGIN', this.options.auth.user, this.options.auth.pass);
            }
        } else {
            throw new AuthenticationFailure('No password configured');
        }

        if (this.authenticated) {
            this.log.info({
                src: 'auth',
                msg: 'User authenticated',
                cid: this.id,
                user: this.options.auth.user
            });
            await this.setAuthenticationState();
            return true;
        }

        throw new AuthenticationFailure('No matching authentication method');
    }

    /** @internal */
    beginSession(onUnhandledError: (err: Error) => void): void {
        clearTimer(this.greetingTimeout);
        this.untaggedHandlers.OK = null;
        this.untaggedHandlers.PREAUTH = null;

        if (this.isClosed) {
            return;
        }

        // get out of current parsing "thread", so do not await for startSession
        this.startSession()
            .then(() => {
                if (typeof this.initialResolve === 'function') {
                    let resolve = this.initialResolve;
                    this.initialResolve = false;
                    this.initialReject = false;
                    return resolve();
                }
            })
            .catch(err => {
                this.log.error({ err, cid: this.id });

                if (typeof this.initialReject === 'function') {
                    clearTimer(this.greetingTimeout);
                    let reject = this.initialReject;
                    this.initialResolve = false;
                    this.initialReject = false;
                    return reject(err);
                }

                onUnhandledError(err);
            });
    }

    /** @internal */
    async initialOK(message: ImapResponse): Promise<void> {
        this.greeting = (message.attributes || [])
            .filter(entry => (entry as ImapAttributeNode).type === 'TEXT')
            .map(entry => (entry as { value: string }).value)
            .filter(entry => entry)
            .join('');

        // ALWAYS emit the error so users can handle it
        this.beginSession(err => this.emitError(err));
    }

    /** @internal */
    async initialPREAUTH(): Promise<void> {
        if (this.isClosed) {
            return;
        }
        this.state = this.states.AUTHENTICATED;
        // documented contract for the `authenticated` property: `true` when the
        // connection was authenticated by a PREAUTH greeting (no credentials known)
        this.authenticated = true;
        this.beginSession(err => {
            this.log.error({ err, cid: this.id });
            this.closeAfter();
        });
    }

    /** @internal */
    async serverBye(parsed: ImapResponse): Promise<void> {
        // Extract BYE reason from response for better error messages
        let reason =
            parsed &&
            parsed.attributes &&
            parsed.attributes
                .filter(val => (val as ImapAttributeNode).type === 'TEXT')
                .map(val => (val as { value: string }).value.trim())
                .join(' ');

        this.byeReason = reason || 'Server closed connection';
        this.untaggedHandlers.BYE = null;
        this.state = this.states.LOGOUT;
    }

    // Drops every capability-derived field together - the counterpart of
    // updateCapabilitiesFromRaw() below, which sets them together. rawCapabilities is
    // public surface external consumers read, so a discard (RFC 9051 6.2.1 requires
    // one after STARTTLS) that missed it would leave the stale list visible if the
    // re-fetch fails.
    /** @internal */
    clearCapabilities(): void {
        this.capabilities.clear();
        this.authCapabilities.clear();
        this.rawCapabilities = null;
    }

    /** @internal */
    updateCapabilitiesFromRaw(rawCapabilities: ImapAttributeList | null | undefined): void {
        this.rawCapabilities = rawCapabilities;
        this.capabilities = updateCapabilities(rawCapabilities);

        if (this.capabilities) {
            for (let [capa] of this.capabilities) {
                if (/^AUTH=/i.test(capa) && !this.authCapabilities.has(capa.toUpperCase())) {
                    this.authCapabilities.set(capa.toUpperCase(), false);
                }
            }
        }

        if (this.expectCapabilityUpdate) {
            this.expectCapabilityUpdate = false;
        }
    }

    /** @internal */
    async sectionCapability(section: ImapAttributeList): Promise<void> {
        this.updateCapabilitiesFromRaw(section);
    }

    /** @internal */
    async untaggedCapability(untagged: ImapResponse): Promise<void> {
        this.updateCapabilitiesFromRaw(untagged.attributes);
    }

    /** @internal */
    async untaggedExists(untagged: ImapResponse): Promise<void> {
        if (!this.mailbox) {
            // mailbox closed, ignore
            return;
        }

        if (!untagged) {
            return;
        }

        // Not a usable count: anything but a bounded digit run. A digit run long enough
        // coerces to Infinity, which would corrupt mailbox state (resolveRange('*') would
        // compile to the literal "Infinity" and every range-based command would fail until
        // the next SELECT)
        let count = parseUintValue(untagged.command, MAX_UINT32_DIGITS);
        if (count === false) {
            return;
        }
        if (count === this.mailbox.exists) {
            // nothing changed?
            return;
        }

        // keep exists up to date
        let prevCount = this.mailbox.exists;
        this.mailbox.exists = count;
        this.emit('exists', {
            path: this.mailbox.path,
            count,
            prevCount
        });
    }

    // Reports one expunged message, either through the caller's expungeHandler or as an
    // 'expunge' event. Shared by the EXPUNGE and VANISHED paths so the two cannot drift.
    /** @internal */
    async notifyExpunge(payload: ExpungeEvent): Promise<void> {
        if (typeof this.options.expungeHandler !== 'function') {
            this.emit('expunge', payload);
            return;
        }

        try {
            await this.options.expungeHandler(payload);
        } catch (err) {
            // The throw comes from the caller's own handler, not from this library
            this.log.error({ msg: 'Failed to notify expunge event', payload, err, cid: this.id });
        }
    }

    /** @internal */
    async untaggedExpunge(untagged: ImapResponse): Promise<void> {
        if (!this.mailbox) {
            // mailbox closed, ignore
            return;
        }

        if (!untagged) {
            return;
        }

        // Same bound untaggedExists() applies: only a bounded decimal run is a usable sequence number
        let seq = parseUintValue(untagged.command, MAX_UINT32_DIGITS);
        if (seq && seq <= this.mailbox.exists) {
            this.mailbox.exists--;
            let payload: ExpungeEvent = {
                path: this.mailbox.path,
                seq,
                vanished: false
            };

            await this.notifyExpunge(payload);
        }
    }

    /** @internal */
    async untaggedVanished(untagged: ImapResponse, mailbox?: MailboxObject | false | undefined): Promise<void> {
        mailbox = mailbox || this.mailbox;
        if (!mailbox) {
            // mailbox closed, ignore
            return;
        }

        let tags: string[] = [];
        let uids: string | false = false;

        // A malformed VANISHED can carry no attributes at all, and one carrying only the
        // (EARLIER) tag leaves `uids` false - expandRange() handles that and yields nothing
        if (!untagged.attributes || !untagged.attributes.length) {
            return;
        }

        if (untagged.attributes.length > 1 && Array.isArray(untagged.attributes[0])) {
            tags = getStringList(untagged.attributes[0]).map(value => value.toUpperCase());
            untagged.attributes.shift();
        }

        if (untagged.attributes[0] && typeof untagged.attributes[0].value === 'string') {
            uids = untagged.attributes[0].value;
        }

        let uidList = expandRange(uids);

        for (let uid of uidList) {
            let payload: ExpungeEvent = {
                path: mailbox.path,
                uid,
                vanished: true,
                earlier: tags.includes('EARLIER')
            };

            await this.notifyExpunge(payload);
        }
    }

    /** @internal */
    async untaggedFetch(untagged: ImapResponse, mailbox?: MailboxObject | false | undefined): Promise<void> {
        mailbox = mailbox || this.mailbox;
        if (!mailbox) {
            // mailbox closed, ignore
            return;
        }

        let message = await formatMessageResponse(untagged, mailbox);
        if (message.flags) {
            let updateEvent: Partial<FlagsEvent> = {
                path: mailbox.path,
                seq: message.seq
            };

            if (message.uid) {
                updateEvent.uid = message.uid;
            }

            if (message.modseq) {
                updateEvent.modseq = message.modseq;
            }

            updateEvent.flags = message.flags;

            if (message.flagColor) {
                updateEvent.flagColor = message.flagColor;
            }

            this.emit('flags', updateEvent as FlagsEvent);
        }
    }

    /** @internal */
    async ensureSelectedMailbox(path: string | string[] | undefined): Promise<MailboxObject | boolean> {
        if (!path) {
            return false;
        }

        if (!this.mailbox || !comparePaths(this, this.mailbox.path, Array.isArray(path) ? normalizePath(this, path) : path)) {
            return await this.mailboxOpen(path);
        }

        return true;
    }

    // Normalizes a message range from various input formats into an IMAP-compatible
    // sequence string (e.g., "1:5,7,10:*"). Handles: numbers, "*", {all:true},
    // {uid:value}, search query objects (resolved via SEARCH), and arrays of numbers.
    /** @internal */
    async resolveRange(range: MessageRange, options: { uid?: boolean | undefined; [key: string]: any }): Promise<string | false> {
        let value: any = range;

        if (typeof value === 'number' || typeof value === 'bigint') {
            value = value.toString();
        }

        // Replace "*" with the actual message count. Some servers reject bare "*"
        // in certain commands, and this also forces a sequence query (not UID).
        if (value === '*') {
            if (!(this.mailbox as MailboxObject).exists) {
                return false;
            }
            value = (this.mailbox as MailboxObject).exists.toString();
            options.uid = false; // sequence query
        }

        if (value && typeof value === 'object' && !Array.isArray(value)) {
            if (value.all && Object.keys(value).length === 1) {
                value = '1:*';
            } else if (value.uid && Object.keys(value).length === 1) {
                value = value.uid;
                options.uid = true;
            } else {
                // Arbitrary search query object: run SEARCH to resolve it into
                // a set of UIDs, then pack into a compact range string.
                options.uid = true; // force UIDs instead of sequence numbers
                value = await this.run('SEARCH', value, options);
                if (value && value.length) {
                    value = packMessageRange(value);
                }
            }
        }

        if (Array.isArray(value)) {
            value = value.join(',');
        }

        if (!value) {
            return false;
        }

        return value;
    }

    // The single definition of "the connection is not free". A held or queued mailbox lock, a
    // command in flight or queued, and an open download stream all mean a caller is
    // mid-sequence: starting IDLE there injects an IDLE/DONE round trip - or, with
    // `missingIdleCommand` set to SELECT or STATUS, a mailbox poll - between two of that
    // caller's own commands. Every one of those states ends by calling autoidle() again, so
    // declining while busy postpones IDLE, it never cancels it.
    /** @internal */
    connectionBusy(): boolean {
        return !!(this.currentLock || this.locks.length || this.currentRequest || this.requestQueue.length || this._openDownloads);
    }

    // Timer process-liveness policy: connection establishment and greeting deadlines keep the
    // process alive, because a caller is waiting on connect() to settle. Background timers
    // (auto-IDLE, IDLE restart, fallback polling, throttle back-off, the held-lock diagnostic) are
    // unref'd, so an otherwise idle process is not held open by them. Every timer is still cleared
    // explicitly on close().
    /** @internal */
    autoidle(): void {
        clearTimer(this.idleStartTimer);
        if (this.options.disableAutoIdle || this.state !== this.states.SELECTED) {
            return;
        }

        if (this.connectionBusy()) {
            return;
        }

        this.idleStartTimer = setTimeout(() => {
            // Re-checked at fire time: paths that take ownership of the connection clear this
            // timer, but the guard must not depend on every one of them doing so - a single
            // missed clearTimeout would inject IDLE between a caller's own commands. Declining
            // postpones rather than cancels: whatever made the connection busy calls autoidle()
            // again when it finishes.
            if (this.state !== this.states.SELECTED || this.connectionBusy()) {
                return;
            }
            this.idle().catch(err => logConnectionError(this, 'Auto-IDLE failed', err));
        }, this.autoIdleDelay);
        unrefTimer(this.idleStartTimer);
    }

    // PUBLIC API METHODS

    /**
     * Initiates a connection against IMAP server. Throws if anything goes wrong. This is something you have to call before you can run any IMAP commands
     *
     * @throws Will throw an error if connection or authentication fails
     * @example
     * let client = new ImapFlow({...});
     * await client.connect();
     */
    async connect(): Promise<void> {
        if (this._connectCalled) {
            // Prevent re-using ImapFlow instances by allowing to call connect just once.
            throw new Error('Can not re-use ImapFlow instance');
        }
        this._connectCalled = true;

        // One deadline for the whole attempt, started before anything is resolved or negotiated.
        // Proxy DNS and proxy negotiation used to run entirely outside the timer, so a stalled
        // proxy could hang far beyond the documented connectionTimeout.
        let deadline = new ConnectionDeadline(this.options.connectionTimeout);

        let connector: { connect: (options: any, listener?: () => void) => net.Socket } = this.secureConnection ? tls : net;

        let opts: tls.ConnectionOptions & net.NetConnectOpts = Object.assign(
            {
                host: this.host,
                servername: this.servername,
                port: this.port
            },
            this.options.tls || {}
        ) as tls.ConnectionOptions & net.NetConnectOpts;

        this.untaggedHandlers.OK = (...args: [ImapResponse]) => this.initialOK(...args);
        this.untaggedHandlers.BYE = (...args: [ImapResponse]) => this.serverBye(...args);
        this.untaggedHandlers.PREAUTH = () => this.initialPREAUTH();

        this.untaggedHandlers.CAPABILITY = (...args: [ImapResponse]) => this.untaggedCapability(...args);
        this.sectionHandlers.CAPABILITY = (...args: [ImapAttributeList]) => this.sectionCapability(...args);

        this.untaggedHandlers.EXISTS = (...args: [ImapResponse]) => this.untaggedExists(...args);
        this.untaggedHandlers.EXPUNGE = (...args: [ImapResponse]) => this.untaggedExpunge(...args);

        // these methods take an optional second argument, so make sure that some random IMAP tag is not used as the second argument
        this.untaggedHandlers.FETCH = untagged => this.untaggedFetch(untagged);
        this.untaggedHandlers.VANISHED = untagged => this.untaggedVanished(untagged);

        let socket: ProxySocket | false | undefined = false;
        if (this.options.proxy) {
            try {
                socket = await proxyConnection(this.log, this.options.proxy, this.host, this.port, { deadline });
                if (!socket) {
                    throw new Error('Failed to setup proxy connection');
                }
            } catch (err) {
                // Logged here rather than relying on proxy-connection.ts, which only reports
                // failures from inside the two connect helpers. An unsupported scheme, a proxy URL
                // that will not parse and a deadline that expired before the connect started all
                // reject before any logging happens there, so this is the one place that sees
                // every way proxy setup can fail.
                this.log.error({ msg: 'Failed to setup proxy connection', err, cid: this.id });

                if ((err as ImapFlowError).code === 'CONNECT_TIMEOUT') {
                    // The shared deadline expired during proxy setup. Report it as the documented
                    // connection timeout rather than as a generic proxy failure.
                    throw err;
                }
                let error: ImapFlowError = new Error('Failed to setup proxy connection');
                error.code = (err as ImapFlowError).code || 'ProxyError';
                error._err = err as Error;
                throw error;
            }
        }

        // Guarded: close() rejects a pending connect() synchronously. See guardedPromise().
        let connectPromise = guardedPromise<void>((resolve, reject) => {
            // Whatever the proxy phase already used is gone from the budget
            this.connectTimeout = setTimeout(() => {
                let err = deadline.error();
                this.log.error({ err, cid: this.id });
                this.closeAfter();
                reject(err);
            }, deadline.remaining());

            let onConnect = () => {
                try {
                    clearTimer(this.connectTimeout);

                    // ImapFlow now owns the socket; drop the proxy's early error handler
                    // (its "before connection setup" message no longer applies).
                    detachEarlyErrorHandler(socket);

                    this.configureSocket(this.socket);

                    this.greetingTimeout = setTimeout(() => {
                        let err: ImapFlowError = new Error(
                            /* c8 ignore next */ // the greeting-timeout test uses a plaintext socket; the secure-socket branch of this hint is not separately exercised
                            `Failed to receive greeting from server in required time${!this.secureConnection ? '. Maybe should use TLS?' : ''}`
                        );
                        err.code = 'GREETING_TIMEOUT';
                        err.details = {
                            /* c8 ignore next */ // firing the timeout with the default (large) value would hang the suite, so only the explicit-option path is tested
                            greetingTimeout: this.options.greetingTimeout || GREETING_TIMEOUT
                        };
                        this.log.error({ err, cid: this.id });
                        this.closeAfter();
                        reject(err);
                    }, this.options.greetingTimeout || GREETING_TIMEOUT);

                    const connected = this.socket as ImapSocket;
                    this.tls = (typeof connected.getCipher === 'function' && connected.getCipher()) || false;

                    let logInfo: { [key: string]: any } = {
                        src: 'connection',
                        msg: `Established ${this.tls ? 'secure ' : ''}TCP connection`,
                        cid: this.id,
                        secure: !!this.tls,
                        host: this.host,
                        servername: this.servername,
                        port: connected.remotePort,
                        address: connected.remoteAddress,
                        localAddress: connected.localAddress,
                        localPort: connected.localPort
                    };

                    if (this.tls) {
                        logInfo.authorized = this.tls.authorized = connected.authorized;
                        /* c8 ignore next */ // cipher.standardName is present on modern Node, so the .name fallback rarely runs
                        logInfo.algo = this.tls.standardName || this.tls.name;
                        logInfo.version = this.tls.version;
                    }

                    this.log.info(logInfo);

                    this.setSocketHandlers();
                    this.setEventHandlers();
                    connected.pipe(this.streamer);

                    // executed by initial "* OK"
                    this.initialResolve = resolve;
                    this.initialReject = reject;
                    /* c8 ignore next 4 */ // defensive: the onConnect setup body does not throw under normal operation
                } catch (ex) {
                    // connect failed
                    reject(ex);
                }
            };

            if (socket) {
                // socket is already established via proxy
                if (this.secureConnection) {
                    // TLS socket requires a handshake
                    opts.socket = socket;
                    this.socket = connector.connect(opts, onConnect);
                } else {
                    // cleartext socket is already usable
                    this.socket = socket;
                    setImmediate(onConnect);
                }
            } else {
                this.socket = connector.connect(opts, onConnect);
            }

            this.writeSocket = this.socket;

            // Store connection error handler for cleanup
            this._connectErrorHandler = (err: Error) => {
                clearTimer(this.connectTimeout);
                clearTimer(this.greetingTimeout);
                this.closeAfter();
                this.log.error({ err, cid: this.id });
                reject(err);
            };
            this.socket.on('error', this._connectErrorHandler);
        });

        await connectPromise;
    }

    /**
     * Graceful connection close by sending logout command to server. TCP connection is closed once command is finished.
     *
     * @example
     * let client = new ImapFlow({...});
     * await client.connect();
     * ...
     * await client.logout();
     */
    async logout(): Promise<void> {
        return await this.run('LOGOUT');
    }

    /**
     * Close the TCP connection.
     * Unlike `close()`, return immediately from this function, allowing the
     * caller function to proceed, and run `close()` function afterwards.
     */
    closeAfter(): void {
        setImmediate(() => this.close());
    }

    // Connection-scoped wrapper around the shared stamping helper; see buildConnectionError().
    /** @internal */
    createConnectionError(code: string, message: string, meta?: ConnectionErrorSite | undefined): ImapFlowError {
        return buildConnectionError(this.id, code, message, meta);
    }

    // The standard "connection not available" error, optionally annotated with the server's BYE
    // reason. Single source of truth so every NoConnection rejection is consistent.
    /** @internal */
    createNoConnectionError(byeReason?: string | false | null | undefined, meta?: ConnectionErrorSite | undefined): ImapFlowError {
        const error = this.createConnectionError('NoConnection', 'Connection not available', meta);
        if (byeReason) {
            error.reason = byeReason;
        }
        return error;
    }

    /**
     * Closes TCP connection without notifying the server.
     *
     * @example
     * let client = new ImapFlow({...});
     * await client.connect();
     * ...
     * client.close();
     */
    close(): void {
        try {
            // clear pending timers
            clearTimer(this.idleStartTimer);
            clearTimer(this.upgradeTimeout);
            clearTimer(this.connectTimeout);
            clearTimer(this.greetingTimeout);

            // Abort every in-flight throttle back-off so each waiter unblocks and its request is
            // settled promptly rather than after the full delay.
            for (let entry of this._throttleWaits) {
                clearTimer(entry.timer);
                entry.resolve(true);
            }
            this._throttleWaits.clear();

            this.usable = false;
            // close() takes over ownership of the idling state: dropping the session token means a
            // poll or IDLE that unwinds after this point sees that it no longer owns the flag and
            // leaves it alone (see claimIdling() in commands/idle.ts).
            this._idleSession = null;
            this.idling = false;

            // An in-flight STARTTLS upgrade has to be settled through its own single settlement
            // path, otherwise the upgrade promise (and the session it belongs to) stays pending
            // for the lifetime of the process.
            if (typeof this._upgradeReject === 'function') {
                let reject = this._upgradeReject;
                this._upgradeReject = null;
                reject(this.createNoConnectionError(false, { rejectedFrom: 'upgrade' }));
            }

            if (typeof this.initialReject === 'function' && !this.options.verifyOnly) {
                clearTimer(this.greetingTimeout);
                let reject = this.initialReject;
                this.initialResolve = false;
                this.initialReject = false;
                let err: ImapFlowError = new Error('Unexpected close');
                /* c8 ignore next */ // closing a pending connect over an already-secure socket (the TLS branch) is not separately exercised
                err.code = `ClosedAfterConnect${this.secureConnection ? 'TLS' : 'Text'}`;
                // Surface the server's BYE reason (e.g. "Too many connections") when the
                // connection was closed by an untagged BYE, so the caller sees why.
                if (this.byeReason) {
                    err.reason = this.byeReason;
                }
                // Synchronous rejection is safe: connectPromise was built by guardedPromise(),
                // so the rejection is already observed. close() is synchronous, so all cleanup
                // completes before any microtask rejection handler runs.
                reject(err);
            }

            if (typeof this.preCheck === 'function') {
                // Runs while the connection is being torn down, so the rejection this sees is
                // almost always the NoConnection close() is about to raise itself.
                this.preCheck().catch(err => logConnectionError(this, 'Failed to break IDLE while closing', err));
            }

            // Session-only public state must not survive the connection it describes: callers read
            // these properties in reconnect logic and would otherwise mistake cached objects for
            // live server state. Cleared during the first close only, so repeated close() calls
            // stay idempotent and cannot emit an event twice.
            // `byeReason` is deliberately kept: it explains why the session ended.
            //
            // `authenticated` is kept for a verifyOnly connection, where it is the result rather
            // than live state. That mode authenticates, optionally lists, and logs out before
            // connect() resolves, so clearing it here left every caller reading `false` off a
            // connection that had just authenticated successfully - there is no later moment at
            // which the answer could be read, and such a client is never reconnected.
            let closedMailbox: MailboxObject | false = false;
            if (!this.isClosed) {
                closedMailbox = this.mailbox;
                this.mailbox = false;
                this.currentSelectCommand = false;
                if (!this.options.verifyOnly) {
                    this.authenticated = false;
                }
                this.preCheck = false;
            }

            // Collect all pending requests to reject
            let pendingRequests: PendingRequest[] = [];

            // reject command that is currently processed
            if (this.currentRequest && this.requestTagMap.has(this.currentRequest.tag)) {
                let tag = this.currentRequest.tag;
                let request = this.requestTagMap.get(tag);
                if (request) {
                    this.requestTagMap.delete(tag);
                    pendingRequests.push(request);
                }
                this.currentRequest = false;
            }

            // reject all other pending commands
            while (this.requestQueue.length) {
                let req = this.requestQueue.shift();
                if (req && this.requestTagMap.has(req.tag)) {
                    let request = this.requestTagMap.get(req.tag);
                    if (request) {
                        this.requestTagMap.delete(req.tag);
                        pendingRequests.push(request);
                    }
                }
            }

            // Reject pending requests and locks synchronously. Every promise rejected here was
            // built by guardedPromise(), so its rejection is already observed and cannot trigger
            // unhandledRejection. close() is synchronous, so all remaining cleanup runs before
            // any microtask rejection handler fires.
            //
            // The error travels on, though, through await chains and .then() links that
            // guardedPromise() knows nothing about. Read a crash stack ending here as "this is
            // the value that escaped", never as "this is the promise that escaped".
            let byeReason = this.byeReason;

            for (let request of pendingRequests) {
                request.reject(this.createNoConnectionError(byeReason, { rejectedFrom: 'pendingRequest', command: request.command }));
            }

            // Clear current lock - holder will see errors when they try operations.
            // Also clear the held-lock diagnostic timer so it doesn't fire post-close.
            if (this.currentLock && this.currentLock.heldWarnTimer) {
                clearTimer(this.currentLock.heldWarnTimer);
                this.currentLock.heldWarnTimer = null;
            }
            this.currentLock = false;

            if (this.locks && this.locks.length) {
                let pendingLocks = this.locks.splice(0); // Take all locks and clear the array
                for (let lock of pendingLocks) {
                    if (lock.acquireTimer) {
                        clearTimer(lock.acquireTimer);
                        lock.acquireTimer = null;
                    }
                    if (typeof lock.reject === 'function') {
                        lock.reject(this.createNoConnectionError(byeReason, { rejectedFrom: 'mailboxLock', path: lock.path }));
                    }
                }
            }

            // cleanup compression streams if they exist
            if (this._inflate) {
                try {
                    this._inflate.unpipe();
                    this._inflate.destroy();
                    this._inflate = null;
                } catch (err) {
                    this.log.error({ err, msg: 'Failed to destroy inflate stream', cid: this.id });
                }
            }

            if (this._deflate) {
                try {
                    this._deflate.unpipe();
                    this._deflate.destroy();
                    this._deflate = null;
                } catch (err) {
                    this.log.error({ err, msg: 'Failed to destroy deflate stream', cid: this.id });
                }
            }

            // cleanup streamer
            if (this.streamer) {
                try {
                    // remove our listeners explicitly by reference
                    if (this.socketReadable) {
                        this.streamer.removeListener('readable', this.socketReadable);
                    }
                    if (this._streamerErrorHandler) {
                        this.streamer.removeListener('error', this._streamerErrorHandler);
                    }
                    if (!this.streamer.destroyed) {
                        this.streamer.destroy();
                    }
                } catch (err) {
                    this.log.error({ err, msg: 'Failed to cleanup streamer', cid: this.id });
                }
            }

            // clear socket handlers
            this.clearSocketHandlers();

            // clear cached data
            this.folders.clear();
            this.requestTagMap.clear();

            this.state = this.states.LOGOUT;
            if (this.isClosed) {
                return;
            }
            // Set before teardown so a socket event that re-enters close() during destruction
            // cannot run this block a second time.
            this.isClosed = true;

            // Socket teardown, in one documented order. Each stream owns and reports its own
            // lifecycle, so each is destroyed exactly once:
            //   1. the compression PassThrough (writeSocket), if compression replaced it
            //   2. the raw socket, which is also writeSocket when compression is not active
            // The compression streams themselves were destroyed above.
            if (this.writeSocket && this.writeSocket !== this.socket && !this.writeSocket.destroyed) {
                try {
                    this.writeSocket.destroy();
                } catch (err) {
                    this.log.error({ err, cid: this.id });
                }
            }

            if (this.socket && !this.socket.destroyed) {
                try {
                    this.socket.destroy();
                } catch (err) {
                    this.log.error({ err, cid: this.id });
                }
            }

            // Null out all socket and handler references so the GC can collect
            // them even if the ImapFlow instance itself is still referenced.
            this.socket = null;
            this.writeSocket = null;
            this._inflate = null;
            this._deflate = null;
            this._streamerErrorHandler = null;
            this._connectErrorHandler = null;
            this._socketError = null;
            this._socketClose = null;
            this._socketEnd = null;
            this._socketTimeout = null;

            this.log.debug({
                msg: 'Connection closed',
                cid: this.id,
                ...(this._unknownTagCount ? { unknownTagCount: this._unknownTagCount } : {})
            });

            // A mailbox that was still selected is now closed, so the transition is reported once,
            // whether the session ended with a clean logout or a lost transport. Emitted before
            // 'close' and only from the first close(), so no consumer sees it twice.
            if (closedMailbox) {
                this.emit('mailboxClose', closedMailbox);
            }

            this.emit('close');
        } catch (ex) {
            // close failed
            this.log.error({ err: ex, cid: this.id });
        }
    }

    /**
     * Returns current quota
     *
     * @param path Optional mailbox path if you want to check quota for specific folder. If value is an array then it is joined using current delimiter symbols. Namespace prefix is added automatically if required.
     * @returns Quota information or `false` if QUOTA extension is not supported or requested path does not exist
     *
     * @example
     * let quota = await client.getQuota();
     * console.log(quota.storage.used, quota.storage.limit)
     */
    async getQuota(path?: string | string[] | undefined): Promise<QuotaResponse | false> {
        path = path || 'INBOX';
        return await this.run('QUOTA', path);
    }

    /**
     * Lists available mailboxes as an Array
     *
     * @param options defines additional listing options
     * @returns An array of ListResponse objects
     *
     * @example
     * let list = await client.list();
     * list.forEach(mailbox=>console.log(mailbox.path));
     */
    async list(options?: ListOptions | undefined): Promise<ListResponse[]> {
        options = options || {};
        let folders: ListResponse[] = await this.run('LIST', '', '*', options);
        this.folders = new Map(folders.map(folder => [folder.path, folder]));
        return folders;
    }

    /**
     * Lists available mailboxes as a tree structured object
     *
     * @param options defines additional listing options
     * @returns Tree structured object
     *
     * @example
     * let tree = await client.listTree();
     * tree.folders.forEach(mailbox=>console.log(mailbox.path));
     */
    async listTree(options?: ListOptions | undefined): Promise<ListTreeResponse> {
        options = options || {};
        let folders: ListResponse[] = await this.run('LIST', '', '*', options);
        this.folders = new Map(folders.map(folder => [folder.path, folder]));
        return getFolderTree(folders);
    }

    /**
     * Performs a no-op call against server
     */
    async noop(): Promise<void> {
        await this.run('NOOP');
    }

    /**
     * Creates a new mailbox folder and sets up subscription for the created mailbox. Throws on error.
     *
     * @param path Full mailbox path. Unicode is allowed. If value is an array then it is joined using current delimiter symbols. Namespace prefix is added automatically if required.
     * @returns Mailbox info
     * @throws Will throw an error if mailbox can not be created
     *
     * @example
     * let info = await client.mailboxCreate(['parent', 'child']);
     * console.log(info.path);
     * // "INBOX.parent.child" // assumes "INBOX." as namespace prefix and "." as delimiter
     */
    async mailboxCreate(path: string | string[]): Promise<MailboxCreateResponse> {
        return await this.run('CREATE', path);
    }

    /**
     * Renames a mailbox. Throws on error.
     *
     * @param path  Path for the mailbox to rename. Unicode is allowed. If value is an array then it is joined using current delimiter symbols. Namespace prefix is added automatically if required.
     * @param newPath New path for the mailbox
     * @returns Mailbox info
     * @throws Will throw an error if mailbox does not exist or can not be renamed
     *
     * @example
     * let info = await client.mailboxRename('parent.child', 'Important stuff');
     * console.log(info.newPath);
     * // "INBOX.Important stuff" // assumes "INBOX." as namespace prefix
     */
    async mailboxRename(path: string | string[], newPath: string | string[]): Promise<MailboxRenameResponse> {
        return await this.run('RENAME', path, newPath);
    }

    /**
     * Deletes a mailbox. Throws on error.
     *
     * @param path Path for the mailbox to delete. Unicode is allowed. If value is an array then it is joined using current delimiter symbols. Namespace prefix is added automatically if required.
     * @returns Mailbox info
     * @throws Will throw an error if mailbox does not exist or can not be deleted
     *
     * @example
     * let info = await client.mailboxDelete('Important stuff');
     * console.log(info.path);
     * // "INBOX.Important stuff" // assumes "INBOX." as namespace prefix
     */
    async mailboxDelete(path: string | string[]): Promise<MailboxDeleteResponse> {
        return await this.run('DELETE', path);
    }

    /**
     * Subscribes to a mailbox
     *
     * @param path Path for the mailbox to subscribe to. Unicode is allowed. If value is an array then it is joined using current delimiter symbols. Namespace prefix is added automatically if required.
     * @returns `true` if subscription operation succeeded, `false` otherwise
     *
     * @example
     * await client.mailboxSubscribe('Important stuff');
     */
    async mailboxSubscribe(path: string | string[]): Promise<boolean> {
        return await this.run('SUBSCRIBE', path);
    }

    /**
     * Unsubscribes from a mailbox
     *
     * @param path **Path for the mailbox** to unsubscribe from. Unicode is allowed. If value is an array then it is joined using current delimiter symbols. Namespace prefix is added automatically if required.
     * @returns `true` if unsubscription operation succeeded, `false` otherwise
     *
     * @example
     * await client.mailboxUnsubscribe('Important stuff');
     */
    async mailboxUnsubscribe(path: string | string[]): Promise<boolean> {
        return await this.run('UNSUBSCRIBE', path);
    }

    /**
     * Opens a mailbox to access messages. You can perform message operations only against an opened mailbox.
     * Using {@link ImapFlow#getMailboxLock} instead of `mailboxOpen()` is preferred. Both do the same thing
     * but next `getMailboxLock()` call is not executed until previous one is released.
     *
     * @param path **Path for the mailbox** to open
     * @param options optional options
     * @returns Mailbox info
     * @throws Will throw an error if mailbox does not exist or can not be opened
     *
     * @example
     * let mailbox = await client.mailboxOpen('Important stuff');
     * console.log(mailbox.exists);
     * // 125
     */
    async mailboxOpen(path: string | string[], options?: MailboxOpenOptions | undefined): Promise<MailboxObject> {
        return await this.run('SELECT', path, options);
    }

    /**
     * Closes a previously opened mailbox
     *
     * @returns Did the operation succeed or not
     *
     * @example
     * let mailbox = await client.mailboxOpen('INBOX');
     * await client.mailboxClose();
     */
    async mailboxClose(): Promise<boolean> {
        return await this.run('CLOSE');
    }

    /**
     * Requests the status of the indicated mailbox. Only requested status values will be returned.
     *
     * @param path mailbox path to check for (unicode string). If value is an array then it is joined using current delimiter symbols. Namespace prefix is added automatically if required.
     * @param query defines requested status items
     * @returns status of the indicated mailbox
     *
     * @example
     * let status = await client.status('INBOX', {unseen: true});
     * console.log(status.unseen);
     * // 123
     */
    async status(path: string | string[], query: StatusQuery): Promise<StatusObject> {
        return await this.run('STATUS', path, query);
    }

    /**
     * Starts listening for new or deleted messages from the currently opened mailbox. Only required if `disableAutoIdle` is set to `true`
     * otherwise IDLE is started by default on connection inactivity. NB! If `idle()` is called manually then it does not
     * return until IDLE is finished which means you would have to call some other command out of scope.
     *
     * @returns Did the operation succeed or not
     *
     * @example
     * let mailbox = await client.mailboxOpen('INBOX');
     *
     * await client.idle();
     */
    async idle(): Promise<boolean | undefined> {
        if (!this.idling) {
            return await this.run('IDLE', this.maxIdleTime);
        }
    }

    /**
     * Sets flags for a message or message range
     *
     * @param range Range to filter the messages
     * @param flags Array of flags to set. Only flags that are permitted to set are used, other flags are ignored
     * @param options Store options
     * @returns Did the operation succeed or not
     *
     * @example
     * let mailbox = await client.mailboxOpen('INBOX');
     * // mark all unseen messages as seen (and remove other flags)
     * await client.messageFlagsSet({seen: false}, ['\Seen]);
     */
    async messageFlagsSet(range: MessageRange, flags: string[], options?: StoreOptions | undefined): Promise<boolean> {
        options = options || {};

        let resolved = await this.resolveRange(range, options);
        if (!resolved) {
            return false;
        }

        let queryOpts = Object.assign(
            {
                operation: 'set'
            },
            options
        );

        return await this.run('STORE', resolved, flags, queryOpts);
    }

    /**
     * Adds flags for a message or message range
     *
     * @param range Range to filter the messages
     * @param flags Array of flags to set. Only flags that are permitted to set are used, other flags are ignored
     * @param options Store options
     * @returns Did the operation succeed or not
     *
     * @example
     * let mailbox = await client.mailboxOpen('INBOX');
     * // mark all unseen messages as seen (and keep other flags as is)
     * await client.messageFlagsAdd({seen: false}, ['\Seen]);
     */
    async messageFlagsAdd(range: MessageRange, flags: string[], options?: StoreOptions | undefined): Promise<boolean> {
        options = options || {};

        let resolved = await this.resolveRange(range, options);
        if (!resolved) {
            return false;
        }

        let queryOpts = Object.assign(
            {
                operation: 'add'
            },
            options
        );

        return await this.run('STORE', resolved, flags, queryOpts);
    }

    /**
     * Remove specific flags from a message or message range
     *
     * @param range Range to filter the messages
     * @param flags Array of flags to remove. Only flags that are permitted to set are used, other flags are ignored
     * @param options Store options
     * @returns Did the operation succeed or not
     *
     * @example
     * let mailbox = await client.mailboxOpen('INBOX');
     * // mark all seen messages as unseen by removing \\Seen flag
     * await client.messageFlagsRemove({seen: true}, ['\Seen]);
     */
    async messageFlagsRemove(range: MessageRange, flags: string[], options?: StoreOptions | undefined): Promise<boolean> {
        options = options || {};

        let resolved = await this.resolveRange(range, options);
        if (!resolved) {
            return false;
        }

        let queryOpts = Object.assign(
            {
                operation: 'remove'
            },
            options
        );

        return await this.run('STORE', resolved, flags, queryOpts);
    }

    /**
     * Sets a colored flag for an email. Only supported by mail clients like Apple Mail
     *
     * @param range Range to filter the messages
     * @param color The color to set. One of 'red', 'orange', 'yellow', 'green', 'blue', 'purple', and 'grey'
     * @param options Store options
     * @returns Did the operation succeed or not
     *
     * @example
     * let mailbox = await client.mailboxOpen('INBOX');
     * // add a purple flag for all emails
     * await client.setFlagColor('1:*', 'Purple');
     */
    async setFlagColor(range: MessageRange, color: string, options?: StoreOptions | undefined): Promise<boolean> {
        options = options || {};

        let resolved = await this.resolveRange(range, options);
        if (!resolved) {
            return false;
        }

        let flagChanges = getColorFlags(color);
        if (!flagChanges) {
            return false;
        }

        let addResults;
        let removeResults;

        if (flagChanges.add && flagChanges.add.length) {
            let queryOpts = Object.assign(
                {
                    operation: 'add'
                },
                options,
                {
                    useLabels: false, // override if set
                    // prevent triggering a premature Flags change notification
                    silent: flagChanges.remove && flagChanges.remove.length
                }
            );

            addResults = await this.run('STORE', resolved, flagChanges.add, queryOpts);
        }

        if (flagChanges.remove && flagChanges.remove.length) {
            let queryOpts = Object.assign(
                {
                    operation: 'remove'
                },
                options,
                { useLabels: false } // override if set
            );

            removeResults = await this.run('STORE', resolved, flagChanges.remove, queryOpts);
        }

        return addResults || removeResults || false;
    }

    /**
     * Delete messages from the currently opened mailbox. Method does not indicate info about deleted messages,
     * instead you should be using the `expunge` event for this
     *
     * @param range Range to filter the messages
     * @param options Range options
     * @returns Did the operation succeed or not
     *
     * @example
     * let mailbox = await client.mailboxOpen('INBOX');
     * // delete all seen messages
     * await client.messageDelete({seen: true});
     */
    async messageDelete(range: MessageRange, options?: MessageRangeOptions | undefined): Promise<boolean> {
        options = options || {};
        let resolved = await this.resolveRange(range, options);
        if (!resolved) {
            return false;
        }
        return await this.run('EXPUNGE', resolved, options);
    }

    /**
     * Appends a new message to a mailbox
     *
     * @param path Mailbox path to upload the message to (unicode string). If value is an array then it is joined using current delimiter symbols. Namespace prefix is added automatically if required.
     * @param content RFC822 formatted email message
     * @param flags an array of flags to be set for the uploaded message
     * @param idate internal date to be set for the message
     * @returns info about uploaded message
     *
     * @example
     * await client.append('INBOX', rawMessageBuffer, ['\\Seen'], new Date(2000, 1, 1));
     */
    async append(
        path: string | string[],
        content: string | Buffer,
        flags?: string[] | undefined,
        idate?: Date | string | undefined
    ): Promise<AppendResponseObject | false> {
        return (await this.run('APPEND', path, content, flags, idate)) || false;
    }

    /**
     * Copies messages from current mailbox to destination mailbox
     *
     * @param range Range of messages to copy
     * @param destination Mailbox path to copy the messages to. If value is an array then it is joined using current delimiter symbols. Namespace prefix is added automatically if required.
     * @param options Range options
     * @returns info about copies messages
     *
     * @example
     * await client.mailboxOpen('INBOX');
     * // copy all messages to a mailbox called "Backup" (must exist)
     * let result = await client.messageCopy('1:*', 'Backup');
     * console.log('Copied %s messages', result.uidMap.size);
     */
    async messageCopy(range: MessageRange, destination: string | string[], options?: MessageRangeOptions | undefined): Promise<CopyResponseObject | false> {
        options = options || {};
        let resolved = await this.resolveRange(range, options);
        if (!resolved) {
            return false;
        }
        return await this.run('COPY', resolved, destination, options);
    }

    /**
     * Moves messages from current mailbox to destination mailbox
     *
     * @param range Range of messages to move
     * @param destination Mailbox path to move the messages to. If value is an array then it is joined using current delimiter symbols. Namespace prefix is added automatically if required.
     * @param options Range options
     * @returns info about moved messages
     *
     * @example
     * await client.mailboxOpen('INBOX');
     * // move all messages to a mailbox called "Trash" (must exist)
     * let result = await client.messageMove('1:*', 'Trash');
     * console.log('Moved %s messages', result.uidMap.size);
     */
    async messageMove(range: MessageRange, destination: string | string[], options?: MessageRangeOptions | undefined): Promise<CopyResponseObject | false> {
        options = options || {};
        let resolved = await this.resolveRange(range, options);
        if (!resolved) {
            return false;
        }
        return await this.run('MOVE', resolved, destination, options);
    }

    /**
     * Search messages from the currently opened mailbox
     *
     * @param query Query to filter the messages
     * @param options Search options. With `returnOptions` set the result is an ESEARCH result object
     * @returns An array of sequence or UID numbers, or an ESearchResult when `returnOptions` was used
     *
     * @example
     * let mailbox = await client.mailboxOpen('INBOX');
     * // find all unseen messages
     * let list = await client.search({seen: false});
     * // use OR modifier (array of 2 or more search queries)
     * let list = await client.search({
     *   seen: false,
     *   or: [
     *     {flagged: true},
     *     {from: 'andris'},
     *     {subject: 'test'}
     *   ]});
     */
    search(query: SearchObject, options?: MessageRangeOptions | undefined): Promise<number[] | false | undefined>;
    search(query: SearchObject, options: SearchOptions & { returnOptions: SearchReturnOption[] }): Promise<ESearchResult | number[] | false | undefined>;
    search(query: SearchObject, options?: SearchOptions | undefined): Promise<ESearchResult | number[] | false | undefined>;
    async search(query: SearchObject, options?: SearchOptions | undefined): Promise<number[] | ESearchResult | false | undefined> {
        if (!this.mailbox) {
            // no mailbox selected, nothing to do
            return;
        }

        const result: number[] | ESearchResult | false = (await this.run('SEARCH', query, options)) || false;

        // When returnOptions was requested but server lacked ESEARCH capability,
        // search.ts returns a plain number[]. Derive ESearchResult client-side.
        if (options && options.returnOptions && Array.isArray(result)) {
            const arr = result;
            // Normalize to uppercase so callers can use mixed-case strings like 'count'
            const normalizedOptions = options.returnOptions.map(o => (typeof o === 'string' ? o.toUpperCase() : o));
            const esearch: ESearchResult = {};
            if (normalizedOptions.includes('COUNT')) {
                esearch.count = arr.length;
            }
            if (normalizedOptions.includes('MIN') && arr.length) {
                esearch.min = arr[0]; // already sorted ascending by search.ts
            }
            if (normalizedOptions.includes('MAX') && arr.length) {
                esearch.max = arr[arr.length - 1];
            }
            if (normalizedOptions.includes('ALL') && arr.length) {
                esearch.all = packMessageRange(arr);
            }
            // PARTIAL cannot be derived client-side, omit it.
            // When returnOptions contains only { partial: ... } items and the server
            // lacks ESEARCH, PARTIAL cannot be derived client-side. Return the raw
            // number[] so the caller has actionable data. Note: this is an edge case,
            // callers targeting no-ESEARCH servers should avoid requesting PARTIAL
            // without COUNT or ALL.
            if (Object.keys(esearch).length === 0) {
                return result;
            }
            return esearch;
        }

        return result;
    }

    /**
     * Fetch messages from the currently opened mailbox
     *
     * @param range Range of messages to fetch
     * @param query Fetch query
     * @param options Fetch options
     * @yields Message data object
     *
     * @example
     * let mailbox = await client.mailboxOpen('INBOX');
     * // fetch UID for all messages in a mailbox
     * for await (let msg of client.fetch('1:*', {uid: true})){
     *     console.log(msg.uid);
     *     // NB! You can not run any IMAP commands in this loop
     *     // otherwise you will end up in a deadloop
     * }
     */
    async *fetch(
        range: MessageRange,
        query: FetchQueryObject,
        options?: FetchOptions | undefined
    ): AsyncGenerator<FetchMessageObject, false | void, undefined> {
        options = options || {};

        if (!this.mailbox) {
            // no mailbox selected, nothing to do
            return;
        }

        let resolved = await this.resolveRange(range, options);
        if (!resolved) {
            return false;
        }

        // Push/pull coordination for the async generator pattern:
        // The FETCH command handler pushes results into rowQueue via onUntaggedFetch.
        // The generator consumer pulls via getNext(). The `push` callback bridges the
        // two: when the consumer is waiting and the queue is empty, `push` is set to
        // a function that wakes up the consumer when new data arrives.
        let finished = false;
        let aborted = false;
        let push: (() => void) | false = false;
        let rowQueue: FetchQueueEntry[] = [];

        let getNext = () =>
            new Promise<FetchRow | null>((resolve, reject) => {
                let check = () => {
                    if (rowQueue.length) {
                        let entry = rowQueue.shift() as FetchQueueEntry;
                        if (entry.err) {
                            return reject(entry.err);
                        }
                        return resolve(entry.value);
                    }

                    if (finished) {
                        return resolve(null);
                    }

                    // No data available yet; register a wakeup callback
                    push = () => {
                        push = false;
                        check();
                    };
                };
                check();
            });

        // Fire-and-forget the FETCH command. It runs in the background while
        // the generator yields results. Each untagged FETCH response is paired
        // with a `next` callback that acts as backpressure: the FETCH handler
        // won't process the next response until the consumer calls next().
        this.run('FETCH', resolved, query, {
            uid: !!options.uid,
            binary: options.binary,
            changedSince: options.changedSince,
            onUntaggedFetch: (untagged: FetchMessageObject, next: () => void) => {
                if (aborted) {
                    next();
                    return;
                }
                rowQueue.push({
                    value: {
                        response: untagged,
                        next
                    }
                });
                if (typeof push === 'function') {
                    push();
                }
            }
        })
            .then(() => {
                finished = true;
                if (typeof push === 'function') {
                    push();
                }
            })
            .catch(err => {
                rowQueue.push({ err });
                if (typeof push === 'function') {
                    push();
                }
            });

        let lastRes: FetchRow | null = null;
        try {
            let res: FetchRow | null;
            while ((res = await getNext())) {
                lastRes = res;

                if (this.isClosed || !this.socket || this.socket.destroyed) {
                    throw this.createConnectionError('EConnectionClosed', 'Connection closed', { rejectedFrom: 'fetchStream', command: 'FETCH' });
                }

                yield res.response;
                // Signal the FETCH handler to process the next untagged response
                res.next();
                lastRes = null;
            }
        } finally {
            aborted = true;
            // Release backpressure for the item that was yielded but whose
            // next() was not yet called (happens on break/return/throw)
            if (lastRes && typeof lastRes.next === 'function') {
                lastRes.next();
            }
            while (rowQueue.length) {
                let entry = rowQueue.shift() as FetchQueueEntry;
                if (entry.value && typeof entry.value.next === 'function') {
                    entry.value.next();
                }
            }
        }
    }

    /**
     * Fetch messages from the currently opened mailbox.
     *
     * This method will fetch all messages before resolving the promise, unlike .fetch(), which
     * is an async generator. Do not use large ranges like 1:*, as this might exhaust all available
     * memory if the mailbox contains a large number of emails.
     * @param range Range of messages to fetch
     * @param query Fetch query
     * @param options Fetch options
     * @returns Array of Message data object
     *
     * @example
     * let mailbox = await client.mailboxOpen('INBOX');
     * // fetch UID for all messages in a mailbox
     * const messages = await client.fetchAll('1:*', {uid: true});
     * for (let msg of messages){
     *     console.log(msg.uid);
     * }
     */
    async fetchAll(range: MessageRange, query: FetchQueryObject, options?: FetchOptions | undefined): Promise<FetchMessageObject[]> {
        const results: FetchMessageObject[] = [];
        const generator = this.fetch(range, query, options);
        for await (const message of generator) {
            results.push(message);
        }
        return results;
    }

    /**
     * Fetch a single message from the currently opened mailbox
     *
     * @param seq Single UID or sequence number of the message to fetch for
     * @param query Fetch query
     * @param options Fetch options
     * @returns Message data object
     *
     * @example
     * let mailbox = await client.mailboxOpen('INBOX');
     * // fetch UID for the last email in the selected mailbox
     * let lastMsg = await client.fetchOne('*', {uid: true})
     * console.log(lastMsg.uid);
     */
    async fetchOne(seq: SequenceString, query: FetchQueryObject, options?: FetchOptions | undefined): Promise<FetchMessageObject | false | undefined> {
        if (!this.mailbox) {
            // no mailbox selected, nothing to do
            return;
        }

        if (seq === '*') {
            if (!this.mailbox.exists) {
                return false;
            }
            seq = this.mailbox.exists.toString();
            options = Object.assign({}, options || {}, { uid: false }); // force into a sequence query
        }

        let response = await this.run('FETCH', (seq || '').toString(), query, options);

        if (!response || !response.list || !response.list.length) {
            return false;
        }

        return response.list[0];
    }

    /**
     * Download either full rfc822 formatted message or a specific bodystructure part as a Stream.
     * Bodystructure parts are decoded so the resulting stream is a binary file. Text content
     * is automatically converted to UTF-8 charset.
     *
     * @param range UID or sequence number for the message to fetch
     * @param part If not set then downloads entire rfc822 formatted message, otherwise downloads specific bodystructure part
     * @param options Download options
     * @returns Download data object. Resolves with an empty object when no mailbox is selected or the message or part was not found
     *
     * @example
     * let mailbox = await client.mailboxOpen('INBOX');
     * // download body part nr '1.2' from latest message
     * let {meta, content} = await client.download('*', '1.2');
     * content.pipe(fs.createWriteStream(meta.filename));
     */
    async download(range: SequenceString, part?: string | undefined, options?: DownloadOptions | undefined): Promise<DownloadObject> {
        if (!this.mailbox) {
            // no mailbox selected, nothing to do
            return {} as DownloadObject;
        }

        let downloadOptions: DownloadOptions & FetchOptions = Object.assign(
            {
                chunkSize: 64 * 1024,
                maxBytes: Infinity
            },
            options || {}
        );

        let hasMore = true;
        let processed = 0;

        let chunkSize = Number(downloadOptions.chunkSize) || 64 * 1024;
        // Normalized once here so every bounded stage of the pipeline below agrees on the budget
        let maxBytes = normalizeByteLimit(downloadOptions.maxBytes);

        let uid: number | false = false;

        if (part === '1') {
            // Special handling for part "1": in single-node emails (no childNodes),
            // the body is accessed via "TEXT" rather than "1", and headers via
            // "HEADER" instead of "1.MIME". Check bodyStructure to detect this.
            let response = await this.fetchOne(range, { uid: true, bodyStructure: true }, downloadOptions);

            if (!response) {
                return { response: false, chunk: false } as unknown as DownloadObject;
            }

            if (!uid && response.uid) {
                uid = response.uid;
                // force UID from now on even if first range was a sequence number
                range = uid;
                downloadOptions.uid = true;
            }

            if (!(response.bodyStructure as MessageStructureObject).childNodes) {
                // single text message
                part = 'TEXT';
            }
        }

        interface PartResult {
            response?: FetchMessageObject | false | undefined;
            chunk?: Buffer | false | undefined;
            mime?: Buffer | undefined;
        }

        let getNextPart = async (query?: FetchQueryObject | undefined): Promise<PartResult> => {
            query = query || {};

            let mimeKey: string | undefined;

            if (!part) {
                query.source = {
                    start: processed,
                    maxLength: chunkSize
                };
            } else {
                part = part.toString().toLowerCase().trim();

                if (!query.bodyParts) {
                    query.bodyParts = [];
                }

                if (query.size) {
                    if (/^[\d.]+$/.test(part)) {
                        // fetch meta as well
                        mimeKey = part + '.mime';
                        query.bodyParts.push(mimeKey);
                    } else if (part === 'text') {
                        mimeKey = 'header';
                        query.bodyParts.push(mimeKey);
                    }
                }

                query.bodyParts.push({
                    key: part,
                    start: processed,
                    maxLength: chunkSize
                });
            }

            let response = await this.fetchOne(range, query, downloadOptions);

            if (!response) {
                return { response: false, chunk: false };
            }

            if (!uid && response.uid) {
                uid = response.uid;
                // force UID from now on even if first range was a sequence number
                range = uid;
                downloadOptions.uid = true;
            }

            let chunk = !part ? response.source : response.bodyParts && response.bodyParts.get(part);
            if (!chunk) {
                return {};
            }

            processed += chunk.length;
            hasMore = chunk.length >= chunkSize;

            let result: PartResult = { chunk };
            if (query.size) {
                result.response = response;
            }

            if (query.bodyParts) {
                if (mimeKey === 'header') {
                    result.mime = response.headers;
                } else {
                    result.mime = response.bodyParts && mimeKey ? response.bodyParts.get(mimeKey) : undefined;
                }
            }

            return result;
        };

        let { response, chunk, mime } = await getNextPart({
            size: true,
            uid: true
        });

        if (!response || !chunk) {
            // ???
            return {} as DownloadObject;
        }

        let meta: DownloadMeta = {
            expectedSize: response.size
        };

        if (!part) {
            meta.contentType = 'message/rfc822';
        } else if (mime) {
            let headers = new Headers(mime);
            let contentType = libmime.parseHeaderValue(headers.getFirst('Content-Type'));
            let transferEncoding = libmime.parseHeaderValue(headers.getFirst('Content-Transfer-Encoding'));
            let disposition = libmime.parseHeaderValue(headers.getFirst('Content-Disposition'));

            if (contentType.value.toLowerCase().trim()) {
                meta.contentType = contentType.value.toLowerCase().trim();
            }

            if (contentType.params.charset) {
                meta.charset = contentType.params.charset.toLowerCase().trim();
            }

            if (transferEncoding.value) {
                meta.encoding = transferEncoding.value
                    .replace(/\(.*\)/g, '')
                    .toLowerCase()
                    .trim();
            }

            if (disposition.value) {
                /* c8 ignore next */ // a parsed disposition value is never all-whitespace, so the `false` fallback is unreachable
                meta.disposition = disposition.value.toLowerCase().trim() || false;
                try {
                    meta.disposition = libmime.decodeWords(meta.disposition as string);
                } catch {
                    // failed to parse disposition, keep as is (most probably an unknown charset is used)
                }
            }

            if (contentType.params.format && contentType.params.format.toLowerCase().trim() === 'flowed') {
                meta.flowed = true;
                if (contentType.params.delsp && contentType.params.delsp.toLowerCase().trim() === 'yes') {
                    meta.delSp = true;
                }
            }

            let filename = disposition.params.filename || contentType.params.name || false;
            if (filename) {
                try {
                    filename = libmime.decodeWords(filename);
                } catch {
                    // failed to parse filename, keep as is (most probably an unknown charset is used)
                }
                meta.filename = filename;
            }
        }

        let stream: Transform;
        let output: Transform;
        let fetchAborted = false;

        // Build a decoder pipeline that progressively transforms the raw FETCH data:
        //   1. Transfer-encoding decoder (base64 or quoted-printable -> binary)
        //   2. Format decoder (format=flowed -> plain text, if applicable)
        //   3. Charset decoder (non-UTF-8 -> UTF-8, for text parts only)
        //   4. Byte limiter (enforces maxBytes cap)
        // `stream` is the head of the pipeline (where raw chunks are written),
        // `output` is the tail (what the caller reads from).
        // Parts that arrived via FETCH BINARY (response.binaryParts) are already
        // decoded by the server - decoding again would corrupt the data, so stage 1
        // is skipped for them.
        let clientEncoding = response.binaryParts && part && response.binaryParts.has(part) ? false : meta.encoding;
        switch (clientEncoding) {
            case 'base64':
                output = stream = new libbase64.Decoder();
                break;
            case 'quoted-printable':
                output = stream = new libqp.Decoder();
                break;
            default:
                output = stream = new PassThrough();
        }

        // Every byte-bounded stage of the pipeline. The fetch loop below stops as soon as any of
        // them has taken all it will accept. The limiter at the tail is not enough on its own: a
        // transform in the middle that buffers its whole input before emitting anything (the
        // format=flowed decoder, the Japanese charset decoder) leaves the tail limiter reporting
        // `limited === false` however much the server sends, so a download with a small maxBytes
        // would still pull the entire part off the wire.
        let limiters: Array<{ limited?: boolean | undefined }> = [];
        let isLimited = () => limiters.some(entry => entry.limited);

        // Appending a stage means forwarding the current tail's errors to it before piping, so a
        // failure anywhere reaches the stream the caller is reading
        let pipeStage = <T extends Transform>(stage: T): T => {
            output.on('error', err => {
                stage.emit('error', err);
            });
            output = output.pipe(stage);
            return stage;
        };

        let isTextNode = ['text/html', 'text/plain', 'text/x-amp-html'].includes(meta.contentType as string) || (part === '1' && !meta.contentType);
        if ((!meta.disposition || meta.disposition === 'inline') && isTextNode) {
            // RFC 3676 format=flowed text: unwrap soft line breaks
            if (meta.flowed) {
                // FlowedDecoder buffers its whole input before emitting, and being third party it
                // carries no bound of its own, so bound what it can ever be handed. Unwrapping only
                // removes bytes, so capping its input at maxBytes cannot push the delivered output
                // above the cap either.
                limiters.push(pipeStage(new LimitedPassthrough({ maxBytes })));

                pipeStage(new FlowedDecoder(meta.delSp ? { delSp: true } : {}) as unknown as Transform);
            }

            // Convert non-UTF-8 charsets to UTF-8 via a streaming decoder.
            // ASCII and UTF-8 need no conversion. Unknown charsets are left as-is.
            if (meta.charset && !['ascii', 'usascii', 'utf8'].includes(meta.charset.toLowerCase().replace(/[^a-z0-9]+/g, ''))) {
                try {
                    let decoder = getDecoder(meta.charset, maxBytes);
                    // Safety listener attached first so the decoder always has at least
                    // one 'error' listener. Prevents Node.js from throwing
                    // ERR_UNHANDLED_ERROR if a later pipe setup step throws and leaves
                    // the source-forwarding closure attached without a downstream
                    // listener wired up. Any real listener the caller attaches still
                    // fires in addition to this one.
                    decoder.on('error', err => {
                        this.log.warn({ err, charset: meta.charset, cid: this.id });
                    });
                    // The Japanese decoder buffers its whole input as well, and reports the same
                    // `limited` flag the limiters do so the fetch loop can stop once it is full.
                    // A streaming decoder has no such flag, which reads as false and is correct.
                    limiters.push(pipeStage(decoder));
                    // force to utf-8 for output
                    meta.charset = 'utf-8';
                } catch {
                    // do not decode charset
                }
            }
        }

        let limiter = pipeStage(new LimitedPassthrough({ maxBytes }));
        limiters.push(limiter);

        // Cleanup function
        const cleanup = () => {
            fetchAborted = true;
            if (stream && !stream.destroyed) {
                stream.destroy();
            }
        };

        // Listen for stream destruction
        output.once('error', cleanup);
        output.once('close', cleanup);

        let writeChunk = (chunk: Buffer): boolean => {
            if (isLimited() || fetchAborted || stream.destroyed) {
                return true;
            }
            return stream.write(chunk);
        };

        // Fetch remaining chunks in a loop, writing each to the decoder stream.
        // Stops when the server returns a short chunk (< chunkSize), the byte
        // limiter is satisfied, or the consumer destroys the output stream.
        let fetchAllParts = async () => {
            while (hasMore && !isLimited() && !fetchAborted) {
                let { chunk } = await getNextPart();
                if (!chunk || fetchAborted) {
                    break;
                }

                // Handle backpressure
                if (writeChunk(chunk) === false) {
                    // Wait for drain event before continuing
                    try {
                        await new Promise<void>((resolve, reject) => {
                            // finish() is the listener itself, as settle() is for the TLS upgrade:
                            // 'drain' and 'close' emit no arguments, 'error' emits the error, and
                            // removal needs no separate handler references. It removes only the
                            // three listeners this wait installed - removeAllListeners('error')
                            // also took off the forwarder pipeStage() attached to the head stream
                            // when the pipeline was built, and the head must keep that forwarder
                            // for the life of the download or a chunk failure has nowhere to go.
                            const finish = (err?: Error | undefined) => {
                                for (let event of ['drain', 'error', 'close']) {
                                    stream.removeListener(event, finish);
                                }

                                /* c8 ignore next 2 */ // stream error during a backpressure drain wait is timing-dependent
                                if (err) {
                                    reject(err);
                                } else {
                                    resolve();
                                }
                            };

                            stream.once('drain', finish);
                            stream.once('error', finish);
                            stream.once('close', finish);
                        });
                        /* c8 ignore start */ // re-throw path only triggers on a stream error mid-drain, which is timing-dependent
                    } catch (err) {
                        // Re-throw only if not aborted
                        if (!fetchAborted) {
                            throw err;
                        }
                    }
                    /* c8 ignore stop */

                    // Check if we should abort after waiting
                    if (fetchAborted) {
                        break;
                    }
                }
            }
        };

        // A download is a sequence of chunk FETCHes with a backpressure wait in between. Those
        // gaps look exactly like an inactive connection, so without this auto-IDLE would start
        // between chunks and the next chunk would have to break it again - two extra round
        // trips per chunk, for as long as the consumer is slow. Counted before control returns
        // to the event loop: the head chunk's own FETCH already armed the auto-IDLE timer, and
        // with a very short autoIdleDelay that timer could otherwise fire before the deferred
        // chunk loop below has marked the download open.
        this._openDownloads++;
        let downloadDone = false;
        let finishDownload = () => {
            if (!downloadDone) {
                downloadDone = true;
                this._openDownloads--;
                this.autoidle();
            }
        };

        // Kick off the download pipeline asynchronously. The first chunk was
        // already fetched above (to get metadata); write it to the decoder
        // stream and then fetch remaining chunks via fetchAllParts().
        // setImmediate ensures the caller gets the {meta, content} return
        // value before streaming begins.
        let runFetchAllParts = () => {
            fetchAllParts()
                .catch(err => {
                    if (!fetchAborted && stream && !stream.destroyed) {
                        stream.emit('error', err);
                        /* c8 ignore start */ // the else logs when a fetch error arrives after the stream was already torn down (timing-dependent)
                    } else {
                        // Log when error cannot be emitted to stream
                        this.log.warn({
                            msg: 'Download error after stream closed',
                            err,
                            fetchAborted,
                            streamDestroyed: stream?.destroyed,
                            cid: this.id
                        });
                    }
                    /* c8 ignore stop */
                })
                .finally(() => {
                    finishDownload();
                    if (!fetchAborted && stream && !stream.destroyed) {
                        stream.end();
                    }
                })
                // Terminal guard: nothing consumes this chain, so a throw from either handler
                // above rejects a promise nobody holds and takes the process down on
                // unhandledRejection. Reaching it always means an invariant broke - the head
                // stream kept pipeStage()'s error forwarder for the life of the download, so
                // emit('error') above has somewhere to go - which is why it logs at error even
                // for a routine-looking connection code.
                .catch(err => this.log.error({ msg: 'Failed to fail the download stream', err, cid: this.id }));
        };

        setImmediate(() => {
            let writeResult;
            try {
                writeResult = writeChunk(chunk);
            } catch (err) {
                stream.emit('error', err);
                finishDownload();
                /* c8 ignore next 3 */ // emitting the error above triggers cleanup (fetchAborted=true), so this end() guard is already false here
                if (!fetchAborted && stream && !stream.destroyed) {
                    stream.end();
                }
                return;
            }

            /* c8 ignore next 9 */ // `stream` is piped to the limiter before this runs, so the head write drains synchronously and always returns true (verified for chunkSize up to 8MB); the drain-wait branch is unreachable
            if (!writeResult) {
                // Initial chunk filled the buffer, wait for drain
                stream.once('drain', () => {
                    if (!fetchAborted) {
                        runFetchAllParts();
                    } else {
                        finishDownload();
                    }
                });
            } else {
                runFetchAllParts();
            }
        });

        return {
            meta,
            content: output as Readable
        };
    }

    /**
     * Fetch multiple attachments as Buffer values
     *
     * @param range UID or sequence number for the message to fetch
     * @param parts A list of bodystructure parts
     * @param options Download options
     * @returns Download data object, keyed by part
     *
     * @example
     * let mailbox = await client.mailboxOpen('INBOX');
     * // download body parts '2', and '3' from all messages in the selected mailbox
     * let response = await client.downloadMany('*', ['2', '3']);
     * process.stdout.write(response[2].content)
     * process.stdout.write(response[3].content)
     */
    async downloadMany(range: SequenceString, parts: string[], options?: DownloadManyOptions | undefined): Promise<DownloadManyResult> {
        if (!this.mailbox) {
            // no mailbox selected, nothing to do
            return {};
        }

        let downloadOptions: DownloadManyOptions & FetchOptions = Object.assign(
            {
                chunkSize: 64 * 1024,
                maxBytes: Infinity
            },
            options || {}
        );

        let query: FetchQueryObject & { bodyParts: string[] } = { bodyParts: [] };

        for (let part of parts) {
            query.bodyParts.push(part + '.mime');
            query.bodyParts.push(part);
        }

        let response = await this.fetchOne(range, query, downloadOptions);

        if (!response || !response.bodyParts) {
            return { response: false } as unknown as DownloadManyResult;
        }

        let data: { [part: string]: { meta?: DownloadMeta | undefined; content?: Buffer | null | undefined } } = {};

        for (let [part, content] of response.bodyParts) {
            let keyParts = part.split('.mime');
            // The server chooses the BODY[...] keys it answers with: never let one be a
            // prototype-chain name, or the assignments below write onto Object.prototype
            // (process-wide pollution) instead of the result object.
            if (isUnsafeKey(keyParts[0])) {
                continue;
            }
            if (keyParts.length === 1) {
                // content
                let key = keyParts[0] as string;
                if (!data[key]) {
                    data[key] = { content };
                } else {
                    data[key].content = content;
                }
            } else if (keyParts.length === 2) {
                // header
                let key = keyParts[0] as string;
                if (!data[key]) {
                    data[key] = {};
                }
                let entry = data[key];
                if (!entry.meta) {
                    entry.meta = {};
                }
                let meta = entry.meta;

                let headers = new Headers(content);
                let contentType = libmime.parseHeaderValue(headers.getFirst('Content-Type'));
                let transferEncoding = libmime.parseHeaderValue(headers.getFirst('Content-Transfer-Encoding'));
                let disposition = libmime.parseHeaderValue(headers.getFirst('Content-Disposition'));

                if (contentType.value.toLowerCase().trim()) {
                    meta.contentType = contentType.value.toLowerCase().trim();
                }

                if (contentType.params.charset) {
                    meta.charset = contentType.params.charset.toLowerCase().trim();
                }

                if (transferEncoding.value) {
                    meta.encoding = transferEncoding.value
                        .replace(/\(.*\)/g, '')
                        .toLowerCase()
                        .trim();
                }

                if (disposition.value) {
                    /* c8 ignore next */ // a parsed disposition value is never all-whitespace, so the `false` fallback is unreachable
                    meta.disposition = disposition.value.toLowerCase().trim() || false;
                    try {
                        meta.disposition = libmime.decodeWords(meta.disposition as string);
                    } catch {
                        // failed to parse disposition, keep as is (most probably an unknown charset is used)
                    }
                }

                if (contentType.params.format && contentType.params.format.toLowerCase().trim() === 'flowed') {
                    meta.flowed = true;
                    if (contentType.params.delsp && contentType.params.delsp.toLowerCase().trim() === 'yes') {
                        meta.delSp = true;
                    }
                }

                let filename = disposition.params.filename || contentType.params.name || false;
                if (filename) {
                    try {
                        filename = libmime.decodeWords(filename);
                    } catch {
                        // failed to parse filename, keep as is (most probably an unknown charset is used)
                    }
                    meta.filename = filename;
                }
            }
        }

        for (let part of Object.keys(data)) {
            let entry = data[part] as { meta?: DownloadMeta | undefined; content?: Buffer | null | undefined };
            // `meta` is only built from the companion BODY[<part>.MIME] item. A server may
            // legally answer with fewer items than were requested, and one part arriving
            // without its MIME headers must not cost the caller the whole download.
            let meta = entry.meta || {};
            entry.meta = meta;

            // parts that arrived via FETCH BINARY (response.binaryParts) are already
            // decoded by the server - decoding again would corrupt the data
            let clientEncoding = response.binaryParts && response.binaryParts.has(part) ? false : meta.encoding;
            switch (clientEncoding) {
                case 'base64':
                    entry.content = entry.content ? libbase64.decode(entry.content.toString()) : null;
                    break;
                case 'quoted-printable':
                    entry.content = entry.content ? libqp.decode(entry.content.toString()) : null;
                    break;
                default:
                // keep as is, already a buffer
            }
        }

        return data as DownloadManyResult;
    }

    /** @internal */
    async run(command: string, ...args: any[]): Promise<any> {
        command = command.toUpperCase();
        if (!this.commands.has(command)) {
            return false;
        }

        if (!this.socket || this.socket.destroyed) {
            throw this.createNoConnectionError(false, { rejectedFrom: 'noSocket', command });
        }

        clearTimer(this.idleStartTimer);

        try {
            // The preCheck (breaking an active IDLE) sits inside the try on purpose: the
            // clearTimeout above is unconditional, so every exit - a failed command or a
            // preCheck that rejects - must still reach the finally, or auto-IDLE would stay
            // disarmed on an otherwise healthy connection until some later command succeeded.
            if (typeof this.preCheck === 'function') {
                await this.preCheck();
            }

            return await this.runInternal(command, ...args);
        } finally {
            // Re-arm auto-IDLE after every command, IDLE included. autoidle() clears any prior
            // timer and declines while the connection is busy or not SELECTED, so calling it
            // unconditionally is safe and is the single place the invariant lives. IDLE was once
            // carved out here on the theory that a command which broke it re-arms on its own way
            // out - but that only holds when a command broke it. When an IDLE or poll session ends
            // on its own (the server refused IDLE, ended it unsolicited, or a poll failed) this is
            // the only thing that re-arms it; without it such a connection would go dark until the
            // socket watchdog tore it down. When a command really did break IDLE, that command is
            // still in flight at this point, so autoidle() declines here and re-arms once it ends.
            this.autoidle();
        }
    }

    /**
     * Dispatches a command without the IDLE handshake that `run()` performs.
     *
     * Used by callers that already own the connection's idle state - fallback polling issues its
     * commands through here, because `run()` would await `preCheck()`, and the preCheck it would
     * await belongs to the very polling session making the call, so the session would cancel
     * itself. Auto-IDLE is not restarted either, for the same reason: the caller is the idle loop.
     *
     * @param command Command name, as registered in the command registry.
     * @param args Arguments forwarded to the command implementation.
     * @returns Whatever the command implementation returns, or `false` for an
     *   unknown command.
     * @internal
     */
    async runInternal(command: string, ...args: any[]): Promise<any> {
        command = command.toUpperCase();
        if (!this.commands.has(command)) {
            return false;
        }

        if (!this.socket || this.socket.destroyed) {
            throw this.createNoConnectionError(false, { rejectedFrom: 'noSocket', command });
        }

        let handler = this.commands.get(command) as CommandHandler;
        return await handler(this, ...args);
    }

    // Mailbox lock queue processor. Implements a mutex pattern: only one lock
    // is active at a time. When the active lock is released, the next queued
    // lock is processed. The `processingLock` flag prevents concurrent runs
    // of this method (which could happen via setImmediate re-entry from release()).
    /** @internal */
    async processLocks(): Promise<void> {
        const wasProcessing = this.processingLock;
        if (wasProcessing) {
            // Another processor is already running; it will pick up new locks
            this.log.trace({
                msg: 'Mailbox locking queued',
                path: this.mailbox && this.mailbox.path,
                pending: this.locks.length,
                idling: this.idling,
                activeLock: this.currentLock
                    ? {
                          lockId: this.currentLock.lockId,
                          ...(this.currentLock.options?.description && { description: this.currentLock.options?.description })
                      }
                    : null
            });
            return;
        }
        this.processingLock = true;

        try {
            // Process all locks in queue until empty
            let processedCount = 0;
            while (this.locks.length > 0) {
                // Mutex invariant: at most one lock may be held at a time.
                // If a lock is already granted, stop processing; release() will
                // clear currentLock and reschedule us to pick up the next queued lock.
                if (this.currentLock) {
                    break;
                }

                // Yield to event loop periodically to prevent CPU blocking
                processedCount++;
                if (processedCount % 5 === 0) {
                    await new Promise(resolve => setImmediate(resolve));
                }

                const lock = this.locks.shift() as MailboxLockEntry;
                const { resolve, reject, path, options, lockId } = lock;

                // From here on the grant/reject path owns the outcome; the acquire
                // timer must not race with resolution.
                if (lock.acquireTimer) {
                    clearTimer(lock.acquireTimer);
                    lock.acquireTimer = null;
                }

                const armHeldTimer = () => {
                    let threshold = Number(options.maxLockHoldTime ?? this.options.maxLockHoldTime ?? HELD_LOCK_WARN_MS);
                    if (!threshold || threshold <= 0) {
                        return;
                    }
                    lock.heldAt = Date.now();
                    // Background diagnostic: must not keep the process alive on its own
                    lock.heldWarnTimer = setTimeout(() => {
                        lock.heldWarnTimer = null;
                        this.log.warn({
                            msg: 'Mailbox lock held for a long time',
                            lockId: lock.lockId,
                            path,
                            heldFor: Date.now() - (lock.heldAt as number),
                            /* c8 ignore next */ // the held-lock-warning diagnostic with a description set is a timing-dependent log detail
                            ...(options.description && { description: options.description }),
                            cid: this.id
                        });
                    }, threshold);
                    unrefTimer(lock.heldWarnTimer);
                };

                // release() is captured per-lock. It must only clear this.currentLock
                // if the caller still owns it - otherwise a stale release (after a
                // disconnect replaced the lock, or a double-release from user code)
                // would clear the new holder's lock and allow concurrent access.
                const release = () => {
                    if (this.currentLock === lock) {
                        if (lock.heldWarnTimer) {
                            clearTimer(lock.heldWarnTimer);
                            lock.heldWarnTimer = null;
                        }
                        this.log.trace({
                            msg: 'Mailbox lock released',
                            lockId: lock.lockId,
                            path: this.mailbox && this.mailbox.path,
                            pending: this.locks.length,
                            idling: this.idling
                        });
                        this.currentLock = false;
                        // autoidle() will not arm while a lock is held, so the release is what
                        // restarts it. It re-checks the queue itself, so a lock waiting behind
                        // this one still keeps IDLE off.
                        this.autoidle();
                        // Use setImmediate to avoid stack overflow
                        setImmediate(() => {
                            this.processLocks().catch(err => this.log.error({ err, cid: this.id }));
                        });
                    } else {
                        this.log.trace({
                            msg: 'Ignoring stale lock release',
                            lockId: lock.lockId,
                            cid: this.id
                        });
                    }
                };

                if (!this.usable || !this.socket || this.socket.destroyed) {
                    this.log.trace({ msg: 'Failed to acquire mailbox lock', path, lockId, idling: this.idling });
                    reject(this.createNoConnectionError(false, { rejectedFrom: 'mailboxLock', path }));
                    continue; // Process next lock in queue
                }

                // Both grant paths finish the same way. autoidle() is re-checked because a stale
                // auto-IDLE timer may still be armed at this point: on the SELECT path run()
                // re-arms auto-IDLE when the SELECT settles - a moment before currentLock is set -
                // and the fast path can inherit a timer from an earlier command. Either way the
                // timer must not fire inside the lock.
                const grantLock = () => {
                    this.currentLock = lock;
                    armHeldTimer();
                    this.autoidle();
                    resolve({ path, release });
                };

                if (this.mailbox && this.mailbox.path === path && !!this.mailbox.readOnly === !!options.readOnly) {
                    // Fast path: mailbox is already selected with the right access mode
                    this.log.trace({
                        msg: 'Mailbox lock acquired [existing]',
                        path,
                        lockId,
                        idling: this.idling,
                        ...(options.description && { description: options.description })
                    });
                    grantLock();
                    break; // Stop processing; next lock waits for release()
                }

                try {
                    // Need to SELECT/EXAMINE a different mailbox
                    await this.mailboxOpen(path, options);
                    this.log.trace({
                        msg: 'Mailbox lock acquired [selected]',
                        path,
                        lockId,
                        idling: this.idling,
                        ...(options.description && { description: options.description })
                    });
                    grantLock();
                    break; // Wait for this lock to be released
                } catch (err) {
                    if ((err as ImapFlowError).responseStatus === 'NO') {
                        // SELECT failed with NO: verify whether the mailbox exists
                        // at all by running LIST. This sets mailboxMissing on the error
                        // so the caller can distinguish "doesn't exist" from other failures.
                        try {
                            let folders = await this.run('LIST', '', path, { listOnly: true });
                            if (!folders || !folders.length) {
                                (err as ImapFlowError).mailboxMissing = true;
                            }
                        } catch (E) {
                            this.log.trace({ msg: 'Failed to verify failed mailbox', path, err: E });
                        }
                    }

                    this.log.trace({
                        msg: 'Failed to acquire mailbox lock',
                        path,
                        lockId,
                        idling: this.idling,
                        ...(options.description && { description: options.description }),
                        err
                    });
                    reject(err as Error);
                    // Continue to next lock in queue
                }
            }
        } finally {
            this.processingLock = false;

            // New locks may have been queued while we were processing (e.g.,
            // a lock that failed immediately and the next getMailboxLock call
            // arrived before we finished). Schedule another run if needed.
            /* c8 ignore start */ // requires a lock to be enqueued during an in-flight processLocks pass; not reproducible deterministically
            if (this.locks.length && !this.currentLock) {
                setImmediate(() => {
                    this.processLocks().catch(err => this.log.error({ err, cid: this.id }));
                });
            }
            /* c8 ignore stop */
        }
    }

    /**
     * Opens a mailbox if not already open and returns a lock. Next call to `getMailboxLock()` is queued
     * until previous lock is released. This is suggested over {@link ImapFlow#mailboxOpen} as
     * `getMailboxLock()` gives you a weak transaction while `mailboxOpen()` has no guarantees whatsoever that another
     * mailbox is opened while you try to call multiple fetch or store commands.
     *
     * @param path **Path for the mailbox** to open
     * @param options optional options
     * @returns Mailbox lock
     * @throws Will throw an error if mailbox does not exist or can not be opened
     *
     * @example
     * let lock = await client.getMailboxLock('INBOX');
     * try {
     *   // do something in the mailbox
     * } finally {
     *   // use finally{} to make sure lock is released even if exception occurs
     *   lock.release();
     * }
     */
    getMailboxLock(path: string | string[], options?: MailboxLockOptions | undefined): Promise<MailboxLockObject> {
        options = options || {};

        let lockPath = normalizePath(this, path);

        let lockId = ++this.lockCounter;
        this.log.trace({
            msg: 'Requesting lock',
            path: lockPath,
            lockId,
            ...(options.description && { description: options.description }),
            activeLock: this.currentLock
                ? {
                      lockId: this.currentLock.lockId,
                      ...(this.currentLock.options?.description && { description: this.currentLock.options?.description })
                  }
                : null
        });

        const lockOptions = options;

        // Guarded: close() rejects every queued lock synchronously. See guardedPromise().
        let lockPromise = guardedPromise<MailboxLockObject>((resolve, reject) => {
            let lockEntry: MailboxLockEntry = { resolve, reject, path: lockPath, options: lockOptions, lockId };
            this.locks.push(lockEntry);

            // Opt-in acquire timeout: if the lock has not been granted within
            // acquireTimeout ms, remove it from the queue and reject. Only
            // affects queued (pending) locks - once granted, the timer is cleared.
            if (Number(lockOptions.acquireTimeout) > 0) {
                lockEntry.acquireTimer = setTimeout(() => {
                    lockEntry.acquireTimer = null;
                    const idx = this.locks.indexOf(lockEntry);
                    if (idx !== -1) {
                        this.locks.splice(idx, 1);
                        let err: ImapFlowError = new Error('Timed out waiting for mailbox lock');
                        err.code = 'LockTimeout';
                        err.lockId = lockEntry.lockId;
                        reject(err);
                    }
                }, Number(lockOptions.acquireTimeout));
            }

            this.processLocks().catch(err => reject(err));
        });

        return lockPromise;
    }

    /** @internal */
    getLogger(): InternalLogger {
        let mainLogger: { [key: string]: any } =
            this.options.logger && typeof this.options.logger === 'object'
                ? this.options.logger
                : logger.child({
                      component: 'imap-connection',
                      cid: this.id
                  });

        let synteticLogger = {} as InternalLogger;
        let levels: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
        for (let level of levels) {
            synteticLogger[level] = (...args: any[]) => {
                // using {logger:false} disables logging
                if (this.options.logger !== false) {
                    const logMethod = mainLogger[level];
                    if (typeof logMethod !== 'function') {
                        // we are checking to make sure the level is supported.
                        // if it isn't supported but the level is error or fatal, log to console anyway.
                        if (level === 'fatal' || level === 'error') {
                            let entry = args[0];
                            try {
                                if (entry && typeof entry === 'object' && entry.err) {
                                    entry = Object.assign({}, entry, { err: flattenLoggedError(entry.err) });
                                }
                                console.error(JSON.stringify(entry));
                            } catch {
                                // Serializing failed (a circular structure, a BigInt, a throwing
                                // getter). This fallback exists so an error is never lost, so hand
                                // the entry to console.error itself - it inspects rather than
                                // serializes, and handles all three - instead of dropping it.
                                console.error(entry);
                            }
                        }
                    } else {
                        (logMethod as (...args: any[]) => void).apply(mainLogger, args);
                    }
                }

                if (this.emitLogs && args && args[0] && typeof args[0] === 'object') {
                    // Guarded for the same reason as the console fallback above: a log call must
                    // never throw. Most of these run inside catch blocks in the protocol
                    // machinery, where a throw would escape the handler that was recovering from
                    // something else and strand the connection. A throwing property getter on the
                    // logged error and a throwing 'log' listener both end up here.
                    try {
                        let logEntry = Object.assign({ level, t: Date.now(), cid: this.id, lo: ++this.lo }, args[0]);
                        if (logEntry.err) {
                            logEntry.err = flattenLoggedError(logEntry.err);
                        }
                        this.emit('log', logEntry);
                    } catch {
                        // Nothing to do with it: reporting the failure would re-enter this
                        // same path
                    }
                }
            };
        }

        return synteticLogger;
    }

    /**
     * Detaches sockets from the IMAP pipeline. Useful for upgrading the connection
     * (e.g., STARTTLS) or transferring socket ownership.
     *
     * @returns Socket objects: `readSocket` is the read socket (inflated socket if compression is enabled, raw socket otherwise),
     *   `writeSocket` the write socket and `socket` the raw underlying socket (same as readSocket/writeSocket when compression is disabled)
     */
    unbind(): { readSocket: Readable; writeSocket: WriteSocket; socket: ImapSocket } {
        const socket = this.socket as ImapSocket;
        socket.unpipe(this.streamer);
        if (this._inflate) {
            this._inflate.unpipe(this.streamer);
        }

        // Detach all of ImapFlow's socket listeners - the raw socket plus, when
        // compression is active, the PassThrough writeSocket - so the connection
        // is fully released to the caller.
        this.clearSocketHandlers();

        const readSocket: Readable = this._inflate || socket;
        const writeSocket: WriteSocket = this.writeSocket || socket;

        // Defense-in-depth: when compression is active the raw socket is orphaned
        // (neither readSocket nor writeSocket) yet still live and still the target
        // of the deflate/writeSocket error forwarders. We just stripped our own
        // error listener, so any post-unbind error (e.g. an upstream ECONNRESET)
        // would become an unhandled 'error' that crashes the host process. Attach
        // a benign listener so the orphaned socket can never throw after handoff.
        // Non-compression path: socket === readSocket === writeSocket and the
        // caller owns it directly, so leave it untouched (no behavior change).
        if (socket !== readSocket && socket !== writeSocket) {
            socket.on('error', err => {
                this.log.debug({ msg: 'Suppressed error on unbound socket', err, cid: this.id });
            });
        }

        return {
            readSocket,
            writeSocket,
            socket
        };
    }
}

/**
 * Connection close event. **NB!** ImapFlow does not handle reconnects automatically.
 * So whenever a 'close' event occurs you must create a new connection yourself.
 *
 * @event ImapFlow#close
 */

/**
 * Error event. In most cases getting an error event also means that connection is closed
 * and pending operations should return with a failure.
 *
 * @event ImapFlow#error
 * @example
 * client.on('error', err=>{
 *     console.log(`Error occurred: ${err.message}`);
 * });
 */

/**
 * Message count in currently opened mailbox changed
 *
 * @event ImapFlow#exists
 * @example
 * client.on('exists', data=>{
 *     console.log(`Message count in "${data.path}" is ${data.count}`);
 * });
 */

/**
 * Deleted message sequence number in currently opened mailbox. One event is fired for every deleted email.
 *
 * @event ImapFlow#expunge
 * @example
 * client.on('expunge', data=>{
 *     console.log(`Message #${data.seq} was deleted from "${data.path}"`);
 * });
 */

/**
 * Flags were updated for a message. Not all servers fire this event.
 *
 * @event ImapFlow#flags
 * @example
 * client.on('flags', data=>{
 *     console.log(`Flag set for #${data.seq} is now "${Array.from(data.flags).join(', ')}"`);
 * });
 */

/**
 * Mailbox was opened
 *
 * @event ImapFlow#mailboxOpen
 * @example
 * client.on('mailboxOpen', mailbox => {
 *     console.log(`Mailbox ${mailbox.path} was opened`);
 * });
 */

/**
 * Mailbox was closed
 *
 * Emitted both when a selected mailbox is closed explicitly, by `mailboxClose()` or by
 * selecting a different mailbox, and when the connection itself goes away while a mailbox
 * was still selected, whether through a clean logout or a lost transport. The transition is
 * reported once per selected mailbox, before the `close` event.
 *
 * @event ImapFlow#mailboxClose
 * @example
 * client.on('mailboxClose', mailbox => {
 *     console.log(`Mailbox ${mailbox.path} was closed`);
 * });
 */

/**
 * Log event if `emitLogs=true`
 *
 * @event ImapFlow#log
 * @example
 * client.on('log', entry => {
 *     console.log(`${entry.cid} ${entry.msg}`);
 * });
 */

// Both `import { ImapFlow } from 'imapflow'` and `import imapflow from 'imapflow'` work, the
// latter matching the shape `require('imapflow')` has always had
const imapflow = { ImapFlow, AuthenticationFailure };

export default imapflow;
