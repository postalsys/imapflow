'use strict';

/**
 * @module imapflow
 */

const tls = require('tls');
const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const logger = require('./logger');
const libmime = require('libmime');
const zlib = require('zlib');
const { Headers } = require('@zone-eu/mailsplit');
const { LimitedPassthrough, normalizeByteLimit } = require('./limited-passthrough');

const { ImapStream } = require('./handler/imap-stream');
const { parser, compiler } = require('./handler/imap-handler');
const packageInfo = require('../package.json');

const libqp = require('libqp');
const libbase64 = require('libbase64');
const FlowedDecoder = require('@zone-eu/mailsplit/lib/flowed-decoder');
const { PassThrough } = require('stream');

const { proxyConnection, detachEarlyErrorHandler } = require('./proxy-connection');
const { ConnectionDeadline } = require('./connection-deadline');

const {
    comparePaths,
    updateCapabilities,
    getFolderTree,
    formatMessageResponse,
    getDecoder,
    packMessageRange,
    normalizePath,
    expandRange,
    AuthenticationFailure,
    getColorFlags,
    hasCapability,
    logConnectionError,
    unrefTimer,
    parseUintValue,
    isUnsafeKey,
    getStringList,
    MAX_UINT32_DIGITS
} = require('./tools');

const imapCommands = require('./imap-commands.js');

const noop = () => {};

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
function hasSensitiveAttribute(attributes) {
    return [].concat(attributes || []).some(node => (Array.isArray(node) ? hasSensitiveAttribute(node) : !!node && node.sensitive));
}

// How deep flattenLoggedError() follows a chain of errors. Bounded because the chain comes from
// whatever failed, not from this library: a cause chain can be arbitrarily long, and the cycle
// check below only catches errors that repeat.
const MAX_ERROR_FLATTEN_DEPTH = 4;

// Recognizes an Error without instanceof, which fails for an error that crossed a realm boundary
// (worker thread, vm context) even though it serializes exactly the same way.
function isErrorLike(value) {
    return value instanceof Error || (!!value && typeof value === 'object' && typeof value.message === 'string' && typeof value.stack === 'string');
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
function flattenLoggedError(value, depth = 0, seen = new Set()) {
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

    let flatErr = {
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

const states = {
    NOT_AUTHENTICATED: 0x01,
    AUTHENTICATED: 0x02,
    SELECTED: 0x03,
    LOGOUT: 0x04
};

/**
 * Normalizes the configured auto-IDLE delay into a value `setTimeout` can honor. Anything Node
 * would silently turn into a 1ms timer - NaN, a negative number, a value above the 32-bit range -
 * falls back to the default instead, because a 1ms delay means an IDLE/DONE round trip around
 * every single command. The delay is also capped below `socketTimeout`, see AUTO_IDLE_SOCKET_MARGIN.
 *
 * @param {*} value - The configured `autoIdleDelay` option.
 * @param {Number} socketTimeout - The normalized socket inactivity timeout.
 * @param {Object} log - Logger, used to report a value that could not be used as given.
 * @param {String} cid - Connection id for the log entry.
 * @returns {Number} Delay in milliseconds.
 */
const normalizeAutoIdleDelay = (value, socketTimeout, log, cid) => {
    const maxDelay = Math.max(0, Math.min(socketTimeout, MAX_TIMER_DELAY) - AUTO_IDLE_SOCKET_MARGIN);
    const configured = value !== undefined && value !== null;

    // Numeric strings are accepted, because configuration usually arrives from an environment
    // variable or a JSON file. Booleans and blank strings are not: Number() would read them as 0,
    // i.e. "IDLE around every command", the opposite of the "off" they suggest.
    let delay = typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN;
    let reason = null;

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

/**
 * @typedef {Object} MailboxObject
 * @global
 * @property {String} path mailbox path
 * @property {String} delimiter mailbox path delimiter, usually "." or "/"
 * @property {Set<string>} flags list of flags for this mailbox
 * @property {String} [specialUse] one of special-use flags (if applicable): "\All", "\Archive", "\Drafts", "\Flagged", "\Junk", "\Sent", "\Trash". Additionally INBOX has non-standard "\Inbox" flag set
 * @property {Boolean} listed `true` if mailbox was found from the output of LIST command
 * @property {Boolean} subscribed `true` if the mailbox is subscribed - reported by LSUB or by LIST RETURN (SUBSCRIBED) on LIST-EXTENDED/IMAP4rev2 servers. Servers that answer neither report no subscription state at all, and every mailbox is then assumed to be subscribed
 * @property {Set<string>} permanentFlags A Set of flags available to use in this mailbox. If it is not set or includes special flag "\\\*" then any flag can be used.
 * @property {String} [mailboxId] unique mailbox ID if server has `OBJECTID` extension enabled
 * @property {BigInt} [highestModseq] latest known modseq value if server has CONDSTORE or XYMHIGHESTMODSEQ enabled
 * @property {Boolean} [noModseq] if true then the server doesn't support the persistent storage of mod-sequences for the mailbox
 * @property {BigInt} uidValidity Mailbox `UIDVALIDITY` value
 * @property {Number} uidNext Next predicted UID
 * @property {Number} exists Messages in this folder
 */

/**
 * @typedef {Object} MailboxLockObject
 * @global
 * @property {String} path mailbox path
 * @property {Function} release Release current lock
 * @example
 * let lock = await client.getMailboxLock('INBOX');
 * try {
 *   // do something in the mailbox
 * } finally {
 *   // use finally{} to make sure lock is released even if exception occurs
 *   lock.release();
 * }
 */

/**
 * Client and server identification object, where key is one of RFC2971 defined [data fields](https://tools.ietf.org/html/rfc2971#section-3.3) (but not limited to).
 * @typedef {Object} IdInfoObject
 * @global
 * @property {String} [name] Name of the program
 * @property {String} [version] Version number of the program
 * @property {String} [os] Name of the operating system
 * @property {String} [vendor] Vendor of the client/server
 * @property {String} ['support-url'] URL to contact for support
 * @property {Date} [date] Date program was released
 */

/**
 * IMAP client class for accessing IMAP mailboxes
 *
 * @class
 * @extends EventEmitter
 */
class ImapFlow extends EventEmitter {
    /**
     * Current module version as a static class property
     * @property {String} version Module version
     * @static
     */
    static version = packageInfo.version;

    /**
     * IMAP connection options
     *
     * @property {String} host
     *     Hostname of the IMAP server.
     *
     * @property {Number} port
     *     Port number for the IMAP server.
     *
     * @property {Boolean} [secure=false]
     *     If `true`, establishes the connection directly over TLS (commonly on port 993).
     *     If `false`, a plain (unencrypted) connection is used first and, if possible, the connection is upgraded to STARTTLS.
     *
     * @property {Boolean} [doSTARTTLS=undefined]
     *     Determines whether to upgrade the connection to TLS via STARTTLS:
     *       - **true**: Start unencrypted and upgrade to TLS using STARTTLS before authentication.
     *         The connection fails if the server does not support STARTTLS or the upgrade fails.
     *         Note that `secure=true` combined with `doSTARTTLS=true` is invalid.
     *       - **false**: Never use STARTTLS, even if the server advertises support.
     *         This is useful if the server has a broken TLS setup.
     *         Combined with `secure=false`, this results in a fully unencrypted connection.
     *         Make sure you warn users about the security risks.
     *       - **undefined** (default): If `secure=false` (default), attempt to upgrade to TLS via STARTTLS before authentication if the server supports it. If not supported, continue unencrypted. This may expose the connection to a downgrade attack.
     *
     * @property {String} [servername]
     *     Server name for SNI or when using an IP address as `host`.
     *
     * @property {Boolean} [disableCompression=false]
     *     If `true`, the client does not attempt to use the COMPRESS=DEFLATE extension.
     *
     * @property {Object} auth
     *     Authentication options. Authentication occurs automatically during {@link connect}.
     *
     * @property {String} auth.user
     *     Username for authentication.
     *
     * @property {String} [auth.pass]
     *     Password for regular authentication.
     *
     * @property {String} [auth.accessToken]
     *     OAuth2 access token, if using OAuth2 authentication.
     *
     * @property {String} [auth.loginMethod]
     *     Optional login method for password-based authentication (e.g., "LOGIN", "AUTH=LOGIN", or "AUTH=PLAIN").
     *     If not set, ImapFlow chooses based on available mechanisms.
     *
     * @property {String} [auth.authzid]
     *     Authorization identity for SASL PLAIN authentication (used for admin impersonation/delegation).
     *     When set, authenticates as `auth.user` but authorizes as `auth.authzid`.
     *     This is typically used in mail systems like Zimbra for admin users to access other users' mailboxes.
     *     Only works with AUTH=PLAIN mechanism.
     *
     * @property {IdInfoObject} [clientInfo]
     *     Client identification info sent to the server (via the ID command).
     *
     * @property {Boolean} [disableAutoIdle=false]
     *     If `true`, do not start IDLE automatically. Useful when only specific operations are needed.
     *
     * @property {Number} [autoIdleDelay=15000]
     *     How long (in milliseconds) the connection has to be inactive before IDLE is started automatically.
     *     Keep it above the pause your own code usually leaves between two commands, otherwise every command is
     *     followed by an IDLE that the next command has to break, costing two extra round-trips per command.
     *     To turn auto-IDLE off entirely use `disableAutoIdle` rather than a very large delay: the value is
     *     capped below `socketTimeout`, because auto-IDLE has to start before the inactivity watchdog fires.
     *     On servers without IDLE support this controls when the polling fallback starts, not how often it
     *     polls - the poll interval is `maxIdleTime`, capped at 2 minutes.
     *
     * @property {Object} [tls]
     *     Additional TLS options. For details, see [Node.js TLS connect](https://nodejs.org/api/tls.html#tls_tls_connect_options_callback).
     *
     * @property {Boolean} [tls.rejectUnauthorized=true]
     *     If `false`, allows self-signed or expired certificates.
     *
     * @property {String} [tls.minVersion='TLSv1.2']
     *     Minimum accepted TLS version (e.g., `'TLSv1.2'`).
     *
     * @property {Number} [tls.minDHSize=1024]
     *     Minimum size (in bits) of the DH parameter for TLS connections.
     *
     * @property {Object|Boolean} [logger]
     *     Custom logger instance with `debug(obj)`, `info(obj)`, `warn(obj)`, and `error(obj)` methods.
     *     If `false`, logging is disabled. If not provided, ImapFlow logs to console in [pino format](https://getpino.io/).
     *
     * @property {Boolean} [logRaw=false]
     *     If `true`, logs all raw data (read and written) in base64 encoding. You can pipe such logs to [eerawlog](https://github.com/postalsys/eerawlog) command for readable output.
     *     Client frames that carry credentials are replaced with a fixed placeholder and the entry is marked with `hidden: true`.
     *
     * @property {Boolean} [emitLogs=false]
     *     If `true`, emits `'log'` events with the same data passed to the logger.
     *
     * @property {Boolean} [verifyOnly=false]
     *     If `true`, disconnects after successful authentication without performing other actions.
     *
     * @property {String} [proxy]
     *     Proxy URL. Supports HTTP CONNECT (`http://`, `https://`) and SOCKS (`socks://`, `socks4://`, `socks4a://`, `socks5://`).
     *     IPv6 proxy endpoints use the URL form, e.g. `socks5://[2001:db8::1]:1080`.
     *
     *     DNS behaviour depends on the proxy protocol:
     *       - `http`/`https`: the destination hostname is sent to the proxy unresolved.
     *       - `socks4`: destination hostnames are resolved locally to IPv4, because SOCKS4 carries
     *         only IPv4 destination addresses and a hostname would silently become a SOCKS4a
     *         request. IPv6 destinations are rejected.
     *       - `socks4a`: destination hostnames are sent to the proxy for remote DNS. IPv6
     *         destinations are rejected.
     *       - `socks`/`socks5`: destination hostnames are sent to the proxy for remote DNS, and
     *         IPv4/IPv6 literals are passed through unchanged.
     *
     *     The proxy endpoint itself is never resolved by ImapFlow - a hostname endpoint is handed
     *     to Node as-is, keeping its normal lookup and connection behaviour.
     *
     * @property {Boolean} [qresync=false]
     *     If `true`, enables QRESYNC support so that EXPUNGE notifications include `uid` instead of `seq`.
     *
     * @property {Number} [maxIdleTime]
     *     If set, breaks and restarts IDLE every `maxIdleTime` milliseconds.
     *
     * @property {String} [missingIdleCommand="NOOP"]
     *     Command to use if the server does not support IDLE.
     *
     * @property {Boolean} [disableBinary=false]
     *     If `true`, ignores the BINARY extension for FETCH and APPEND operations.
     *
     * @property {Boolean} [disableAutoEnable=false]
     *     If `true`, do not automatically enable supported IMAP extensions.
     *
     * @property {Boolean} [disableIMAP4rev2=false]
     *     If `true`, do not enable IMAP4rev2 mode even if the server supports it.
     *     Use as a targeted opt-out for servers with broken IMAP4rev2 implementations
     *     without losing the other auto-enabled extensions.
     *
     * @property {Number} [connectionTimeout=90000]
     *     Maximum time (in milliseconds) to wait for a usable transport. Covers DNS resolution,
     *     proxy negotiation and the TCP/TLS handshake as a single budget, so an expiry in any of
     *     those phases rejects with error code `CONNECT_TIMEOUT`. Defaults to 90 seconds.
     *
     * @property {Number} [greetingTimeout=16000]
     *     Maximum time (in milliseconds) to wait for the server greeting after a connection is established. Defaults to 16 seconds.
     *
     * @property {Number} [socketTimeout=300000]
     *     Maximum period of inactivity (in milliseconds) before terminating the connection. Defaults to 5 minutes.
     */

    constructor(options) {
        super({ captureRejections: true });

        this.options = options || {};

        /**
         * Instance ID for logs
         * @type {String}
         */
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

        /**
         * Server identification info. Available after successful `connect()`.
         * If server does not provide identification info then this value is `null`.
         * @example
         * await client.connect();
         * console.log(client.serverInfo.vendor);
         * @type {IdInfoObject|null}
         */
        this.serverInfo = null; //updated by ID

        this.log = this.getLogger();

        /**
         * Is the connection currently encrypted or not
         * @type {Boolean}
         */
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

        // In-flight throttle back-offs (see throttleWait()). Tracked as a set because more than
        // one can be pending at a time: the reader's connection-level back-off and a command
        // retrying its own throttled request. close() clears them all.
        this._throttleWaits = new Set();

        // Pending rejector of the in-flight STARTTLS upgrade promise (see upgradeToSTARTTLS()).
        // Stored so emitError() can route a streamer-originated error into the upgrade's single
        // error path instead of dropping it (which could hang a verifyOnly connect()).
        this._upgradeReject = null;

        this.isClosed = false;

        this.states = states;
        this.state = this.states.NOT_AUTHENTICATED;

        this.lockCounter = 0;

        this.tagCounter = 0;
        this.requestTagMap = new Map();
        this.requestQueue = [];
        this.currentRequest = false;

        // Count of tagged responses whose tag was never issued by this connection. Tolerated
        // (non-conforming servers do this) but tracked, so the compatibility decision in
        // countUnknownTag() can be revisited with field data instead of guesses. Warnings are
        // emitted at the milestones below (1, 2, 4, 8, ...) so the count stays exact without
        // turning a spraying server into a log flood.
        this._unknownTagCount = 0;
        this._nextUnknownTagWarn = 1;

        this.writeBytesCounter = 0;

        this.commandParts = [];

        // Whether the command currently being written carries credentials. send() sets this for
        // every command before its first frame reaches the socket, and the raw traffic log reads
        // it; every write belongs to the command send() dispatched last, because trySend() keeps
        // one command in flight at a time. The initial value only covers a write before the
        // first command, which no current path performs. See write().
        this.rawSensitiveCommand = true;

        /**
         * Active IMAP capabilities. Value is either `true` for toggleable capabilities (eg. `UIDPLUS`)
         * or a number for capabilities with a value (eg. `APPENDLIMIT`)
         * @type {Map<string, boolean|number>}
         */
        this.capabilities = new Map();
        this.authCapabilities = new Map();

        this.rawCapabilities = null;

        this.expectCapabilityUpdate = false; // force CAPABILITY after LOGIN

        // Set true if the server sent data after the STARTTLS OK and before the TLS
        // handshake (a plaintext-injection signal). See upgradeToSTARTTLS().
        this._starttlsHadTrailingData = false;

        /**
         * Enabled capabilities. Usually `CONDSTORE` and `UTF8=ACCEPT` if server supports these.
         * @type {Set<string>}
         */
        this.enabled = new Set();

        /**
         * Is the connection currently usable or not
         * @type {Boolean}
         */
        this.usable = false;

        /**
         * Currently authenticated user or `false` if mailbox is not open
         * or `true` if connection was authenticated by PREAUTH
         * @type {String|Boolean}
         */
        this.authenticated = false;

        /**
         * Currently selected mailbox or `false` if mailbox is not open
         * @type {MailboxObject|Boolean}
         */
        this.mailbox = false;
        this.currentSelectCommand = false;

        /**
         * Is current mailbox idling (`true`) or not (`false`)
         * @type {Boolean}
         */
        this.idling = false;

        this.emitLogs = !!this.options.emitLogs;
        // ordering number for emitted logs
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

        // Wall-clock time of the last fallback poll, owned by lib/commands/idle.js
        this._lastPollAt = 0;

        // Download streams still fetching chunks. Counted, not a flag, so overlapping downloads
        // cannot clear each other's suppression of auto-IDLE.
        this._openDownloads = 0;
        this.missingIdleCommand = (this.options.missingIdleCommand || '').toString().toUpperCase().trim() || 'NOOP';

        this.disableBinary = !!this.options.disableBinary;

        // Set when the server rejects a LIST RETURN option group, the auxiliary
        // SPECIAL-USE/CHILDREN return options, or the LSUB command, so later
        // listings on this connection skip what the server does not support
        this.skipListSubscribedArg = false;
        this.skipListStatusArgs = false;
        this.skipListAuxArgs = false;
        this.skipLsub = false;

        // Named error handler for proper cleanup. Certain error codes represent
        // expected socket/network issues (buffer exhaustion, connection reset, broken pipe,
        // timeout, unreachable host) that just need a silent connection close rather
        // than emitting an error event to the caller.
        this._streamerErrorHandler = err => {
            if (['Z_BUF_ERROR', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH'].includes(err.code)) {
                this.closeAfter();
                return;
            }

            this.log.error({ err, cid: this.id });
            this.emitError(err);
        };
        this.streamer.on('error', this._streamerErrorHandler);

        // Has the `connect` method already been called
        this._connectCalled = false;
    }

    emitError(err) {
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

    getRandomId() {
        let rid = BigInt('0x' + crypto.randomBytes(13).toString('hex')).toString(36);
        if (rid.length < 20) {
            rid = '0'.repeat(20 - rid.length) + rid;
        }
        if (rid.length > 20) {
            rid = rid.substr(0, 20);
        }
        return rid;
    }

    write(chunk) {
        if (!this.socket || this.socket.destroyed) {
            // do not write after connection end or logout
            const error = new Error('Socket is already closed');
            error.code = 'NoConnection';
            throw error;
        }

        if (this.state === this.states.LOGOUT) {
            // should not happen
            const error = new Error('Can not send data after logged out');
            error.code = 'StateLogout';
            throw error;
        }

        if (this.writeSocket.destroyed) {
            this.log.error({ msg: 'Write socket destroyed', cid: this.id });
            this.close();
            return;
        }

        // Append CRLF only to the final part of a command. When sending literals,
        // commandParts holds the remaining parts (literal data, continuation); the CRLF
        // delimiter is only added when no more parts remain (the command is complete).
        let addLineBreak = !this.commandParts.length;
        if (typeof chunk === 'string') {
            if (addLineBreak) {
                chunk += '\r\n';
            }
            chunk = Buffer.from(chunk, 'binary');
        } else if (Buffer.isBuffer(chunk)) {
            if (addLineBreak) {
                chunk = Buffer.concat([chunk, Buffer.from('\r\n')]);
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
                data: this.rawSensitiveCommand ? RAW_HIDDEN_PLACEHOLDER : chunk.toString('base64'),
                ...(this.rawSensitiveCommand ? { hidden: true } : {}),
                compress: !!this._deflate,
                secure: !!this.secureConnection,
                cid: this.id
            });
        }

        this.writeBytesCounter += chunk.length;

        this.writeSocket.write(chunk);
    }

    /**
     * Returns byte counters for the current connection.
     *
     * @param {Boolean} [reset] If `true` then resets the byte counters after returning the current values
     * @returns {Object} Byte counters
     * @returns {Number} return.sent Bytes sent to server
     * @returns {Number} return.received Bytes received from server
     */
    stats(reset) {
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
    async send(data) {
        if (this.state === this.states.LOGOUT) {
            // already logged out
            if (data.tag) {
                let request = this.requestTagMap.get(data.tag);
                if (request) {
                    this.requestTagMap.delete(request.tag);
                    const error = new Error('Connection not available');
                    error.code = 'NoConnection';
                    request.reject(error);
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
        this.write(this.commandParts.shift());

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

    async trySend() {
        while (!this.currentRequest && this.requestQueue.length) {
            this.currentRequest = this.requestQueue.shift();

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
                this.rejectCurrentRequest(err);
            }
        }
    }

    exec(command, attributes, options) {
        if (this.state === this.states.LOGOUT || this.isClosed) {
            const error = new Error('Connection not available');
            error.code = 'NoConnection';
            let p = Promise.reject(error);
            p.catch(noop);
            return p;
        }

        if (!this.socket || this.socket.destroyed) {
            let error = new Error('Connection closed');
            error.code = 'EConnectionClosed';
            let p = Promise.reject(error);
            p.catch(noop);
            return p;
        }

        let tag = (++this.tagCounter).toString(16).toUpperCase();

        options = options || {};

        let promise = new Promise((resolve, reject) => {
            this.requestTagMap.set(tag, { command, attributes, options, resolve, reject });
            this.requestQueue.push({ tag, command, attributes, options });
            // trySend() settles dispatch failures itself, by rejecting the affected
            // command through requestTagMap; this catch exists only so a throw from the
            // dispatch machinery itself can never surface as a floating rejection.
            this.trySend().catch(err => logConnectionError(this, 'Failed to dispatch command', err));
        });

        // Prevent unhandled promise rejection if close() rejects this request
        // synchronously before the caller's handler is attached. The rejection
        // still propagates normally to the caller's await/.catch().
        promise.catch(noop);

        return promise;
    }

    // Resolves an untagged server response to the keyword it is dispatched on. IMAP untagged
    // responses come in two forms:
    //   * CAPABILITY ...       (keyword as command)
    //   * 42 FETCH (...)       (numeric prefix + keyword)
    // For numeric-prefixed responses the keyword sits in the first attribute, because `command`
    // holds the sequence number. Also used for logging, so a failure reports FETCH rather than
    // the message number that happened to precede it.
    normalizeUntaggedCommand(command, attributes) {
        if (/^[0-9]+$/.test(command)) {
            let type = attributes && attributes.length && typeof attributes[0].value === 'string' ? attributes[0].value.toUpperCase() : false;
            if (type) {
                command = type;
            }
        }

        return command.toUpperCase().trim();
    }

    // Handler priority: command-specific handlers (registered per exec() call) take
    // precedence over global handlers (registered on the connection).
    getUntaggedHandler(command, attributes) {
        command = this.normalizeUntaggedCommand(command, attributes);
        // Check command-specific handler first (registered in exec() options.untagged)
        if (this.currentRequest && this.currentRequest.options && this.currentRequest.options.untagged && this.currentRequest.options.untagged[command]) {
            return this.currentRequest.options.untagged[command];
        }

        // Fall back to global handler (e.g., for CAPABILITY, BYE, etc.)
        if (this.untaggedHandlers[command]) {
            return this.untaggedHandlers[command];
        }
    }

    getSectionHandler(key) {
        if (this.sectionHandlers[key]) {
            return this.sectionHandlers[key];
        }
    }

    // Releases a readable stream item exactly once. The item's `next` callback is the parser's
    // backpressure token: until it is called, ImapStream stops feeding the connection. Every
    // path out of response handling - success, handled error, or unexpected throw - has to go
    // through here, otherwise the parser stalls permanently.
    releaseStreamData(data) {
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
    countUnknownTag(tag) {
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
    failProtocol(err) {
        if (this.streamer && !this.streamer.destroyed) {
            // Destroyed without an error: nothing after a protocol violation may reach
            // application state, and emitError() below owns reporting.
            this.streamer.destroy();
        }
        this.emitError(err);
    }

    // Rejects the in-flight request, if any, exactly once. Used when response handling fails in
    // a way that leaves the command's outcome unknown.
    rejectCurrentRequest(err) {
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
     * @param {Number} delay - Requested delay in milliseconds.
     * @returns {Promise<Boolean>} True if close() aborted the wait, false on normal expiry.
     */
    async throttleWait(delay) {
        delay = Math.min(Math.max(Number(delay) || 0, 0), MAX_THROTTLE_DELAY);

        return await new Promise(resolve => {
            let entry = { resolve };
            entry.timer = setTimeout(() => {
                this._throttleWaits.delete(entry);
                resolve(false);
            }, delay);
            unrefTimer(entry.timer);
            this._throttleWaits.add(entry);
        });
    }

    async reader() {
        let data;
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
                let error = new Error('Failed to process server response');
                error.code = 'ResponseProcessingFailed';
                error._err = err;
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
     * @param {Buffer} payload - Raw bytes of the line that failed to parse.
     * @param {Error} parserError - The error the parser raised.
     */
    rejectUnparsedCompletion(payload, parserError) {
        if (!this.currentRequest || !this.currentRequest.sent) {
            return;
        }

        // Prefer the tag the parser had already extracted before it failed - it went
        // through the same leading-NUL workaround as every parsed response. Fall back
        // to the raw bytes for lines whose tag itself was unparseable: skip the NUL
        // padding buggy servers prepend and stop at the first byte a tag cannot contain.
        let tag = parserError && parserError.parsedTag;
        if (!tag) {
            // eslint-disable-next-line no-control-regex
            let match = payload.toString('latin1', 0, 64).match(/^\0*([^\s\x00-\x1f\x7f]+)/);
            tag = match && match[1];
        }
        if (!tag || tag !== this.currentRequest.tag) {
            return;
        }

        let err = new Error('Failed to parse the server response for this command');
        err.code = parserError.code || 'ParserError';
        err.parserError = parserError;
        this.rejectCurrentRequest(err);

        this.trySend().catch(sendErr => logConnectionError(this, 'Failed to dispatch command', sendErr));
    }

    /**
     * Handles a single parsed server response: telemetry, continuation requests, response-code
     * section handlers, untagged handlers and tagged command completion.
     *
     * @param {Object} data - Readable item from the parser stream.
     * @returns {Promise<Boolean>} `true` to keep reading, `false` to stop (connection is failing).
     */
    async handleResponse(data) {
        let parsed;

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
            this.rejectUnparsedCompletion(data.payload, err);
            return true;
        }

        if (parsed.tag && !['*', '+'].includes(parsed.tag) && parsed.command) {
            let payload = { response: parsed.command };

            if (
                parsed.attributes &&
                parsed.attributes[0] &&
                parsed.attributes[0].section &&
                parsed.attributes[0].section[0] &&
                parsed.attributes[0].section[0].type === 'ATOM'
            ) {
                payload.code = parsed.attributes[0].section[0].value;
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

        if (/^\d+$/.test(parsed.command) && parsed.attributes && parsed.attributes[0] && parsed.attributes[0].value === 'FETCH') {
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
                this.log.warn({ msg: 'Failed to process continuation response', command: this.currentRequest?.command, err, cid: this.id });
            }
            return true;
        }

        // Server acknowledged our literal size with "+", send the actual literal data
        if (parsed.tag === '+' && this.commandParts.length) {
            let content = this.commandParts.shift();
            // A write() failure here (e.g. socket closed mid-command) must not fail the whole
            // connection; the command's own tagged response or the close path reports it.
            try {
                this.write(content);
                this.log.debug({ src: 'c', msg: `(* ${content.length}B continuation *)`, cid: this.id });
            } catch (err) {
                logConnectionError(this, 'Failed to send literal continuation', err);
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
                // applied its own state (e.g. select.js publishing the new mailbox), so the next
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
                let request = this.requestTagMap.get(parsed.tag);
                this.requestTagMap.delete(parsed.tag);

                let err = new Error('Server sent a tagged response for a command that was not in flight');
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
     * @param {Object} request - Pending request entry (resolve/reject and the compiled command).
     * @param {Object} parsed - Parsed tagged response.
     * @param {Boolean} hasTrailingData - Whether more input was already buffered after this line.
     * @returns {Promise<void>}
     */
    async settleRequest(request, parsed, hasTrailingData) {
        switch ((parsed.command || '').toUpperCase()) {
            case 'OK':
            case 'BYE':
                // hasTrailingData is forwarded so STARTTLS can detect a plaintext
                // injection (data buffered after the tagged OK, before the handshake).
                await new Promise(resolve => request.resolve({ response: parsed, next: resolve, hasTrailingData }));
                break;

            case 'NO':
            case 'BAD': {
                let txt =
                    parsed.attributes &&
                    parsed.attributes
                        .filter(val => val.type === 'TEXT')
                        .map(val => val.value.trim())
                        .join(' ');

                let err = new Error('Command failed');
                err.response = parsed;
                err.responseStatus = parsed.command.toUpperCase();

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
                        await new Promise(resolve => request.resolve({ response: parsed, next: resolve }));
                        break;
                    }

                    let throttleDelay = false;

                    // MS365 throttling detection: Office 365 returns BAD with a human-readable
                    // backoff time when rate limits are hit. Parse the delay from the response text.
                    // Example: "tag BAD Request is throttled. Suggested Backoff Time: 92415 milliseconds"
                    if (/Request is throttled/i.test(txt) && /Backoff Time/i.test(txt)) {
                        let throttlingMatch = txt.match(/Backoff Time[:=\s]+(\d+)/i);
                        if (throttlingMatch && throttlingMatch[1] && !isNaN(throttlingMatch[1])) {
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
                            request.reject(this.createNoConnectionError(this.byeReason));
                            break;
                        }
                    }
                }

                request.reject(err);
                break;
            }

            default: {
                let err = new Error('Invalid server response');
                err.code = 'InvalidResponse';
                err.response = parsed;
                request.reject(err);
                break;
            }
        }
    }

    setEventHandlers() {
        // Bind the 'readable' event to kick off the reader loop.
        // The `this.reading` flag acts as a concurrency guard: if reader()
        // is already running, new 'readable' events are ignored. The reader
        // loop will keep draining data until the stream returns null.
        this.socketReadable = () => {
            if (!this.reading) {
                this.reading = true;
                this.reader()
                    .catch(err => this.log.error({ err, cid: this.id }))
                    .finally(() => {
                        this.reading = false;
                    });
            }
        };

        this.streamer.on('readable', this.socketReadable);
    }

    /**
     * Applies the transport options every established application socket needs: TCP keepalive and
     * the inactivity watchdog. Called for direct TLS, cleartext, proxied and STARTTLS-upgraded
     * sockets, so the watchdog cannot silently differ between transports (a STARTTLS session used
     * to end up with no armed timer at all).
     *
     * @param {Object} socket - The socket that now carries the IMAP session.
     */
    configureSocket(socket) {
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

    setSocketHandlers() {
        // Clear any existing handlers first to prevent duplicates
        this.clearSocketHandlers();

        this._socketError =
            this._socketError ||
            (err => {
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
         * @fires ImapFlow#error Emits error event if the connection cannot be recovered
         */
        this._socketTimeout =
            this._socketTimeout ||
            (() => {
                const err = new Error('Socket timeout');
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

        this.socket.once('error', this._socketError);
        this.socket.once('close', this._socketClose);
        this.socket.once('end', this._socketEnd);

        this.socket.on('tlsClientError', this._socketError);
        this.socket.on('timeout', this._socketTimeout);

        if (this.writeSocket && this.writeSocket !== this.socket) {
            this.writeSocket.on('error', this._socketError);
        }
    }

    clearSocketHandlers() {
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

    async startSession() {
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
    async autoEnable() {
        let enableList = ['CONDSTORE', 'UTF8=ACCEPT'].concat(this.options.qresync ? 'QRESYNC' : []).concat(this.options.disableIMAP4rev2 ? [] : 'IMAP4rev2');
        let enableResult = await this.run('ENABLE', enableList);
        if (enableResult === false && enableList.includes('IMAP4rev2')) {
            // RFC 5161 requires servers to ignore unknown ENABLE arguments, but a
            // broken implementation may reject the whole command over IMAP4rev2 -
            // retry without it so CONDSTORE/QRESYNC are not lost as collateral
            await this.run(
                'ENABLE',
                enableList.filter(extension => extension !== 'IMAP4rev2')
            );
        }
    }

    async compress() {
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

        // Reroute incoming data through inflate: socket -> inflate -> streamer.
        // The streamer's compress flag tells it to expect deflated framing.
        this.socket.unpipe(this.streamer);
        this.streamer.compress = true;
        this.socket.pipe(this._inflate).pipe(this.streamer);
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
        this.writeSocket = new PassThrough({
            highWaterMark: 64 * 1024 // 64KB buffer limit to prevent excessive memory usage
        });

        /* c8 ignore start */ // destroySoon override is never invoked by ImapFlow (close() calls destroy()); kept for stream API completeness
        this.writeSocket.destroySoon = () => {
            try {
                if (this.socket) {
                    this.socket.destroy();
                }
                this.writeSocket.end();
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
        let readNext = async () => {
            try {
                reading = true;
                processedChunks = 0;

                let chunk;
                while (this.writeSocket && (chunk = this.writeSocket.read()) !== null) {
                    if (this._deflate && this._deflate.write(chunk) === false) {
                        return this._deflate.once('drain', readNext);
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
                this.emitError(ex);
            }
        };

        this.writeSocket.on('readable', () => {
            if (!reading && this.writeSocket) {
                readNext();
            }
        });
        this.writeSocket.on('error', err => {
            if (this.socket) {
                this.socket.emit('error', err);
            }
        });

        this._deflate.pipe(this.socket);
        this._deflate.on('error', err => {
            if (this.socket) {
                this.socket.emit('error', err);
            }
        });
    }

    _failSTARTTLS() {
        if (this.options.doSTARTTLS === true) {
            // STARTTLS configured as requirement
            let err = new Error('Server does not support STARTTLS');
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
     * @returns {boolean} true, if the connection is now protected by TLS, either direct TLS or STARTTLS.
     */
    async upgradeToSTARTTLS() {
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

        // STARTTLS plaintext-injection guard (RFC 3501 §6.2.1): a compliant server stays
        // silent after the tagged STARTTLS OK until the TLS handshake, so any data that
        // followed the OK was injected by a MITM and must not be treated as if it arrived
        // over TLS. Two complementary best-effort checks fail closed before wrapping the
        // socket; injection that still races in afterwards corrupts the TLS handshake and
        // is rejected there instead (with a generic TLS error rather than STARTTLS_INJECTION).
        const failSTARTTLSInjection = () => {
            let err = new Error('Server sent data after the STARTTLS response and before the TLS handshake; possible plaintext-injection attack');
            err.code = 'STARTTLS_INJECTION';
            err.tlsFailed = true;
            this.closeAfter();
            return err;
        };

        // Check 1: the parser saw more input already buffered right after the tagged OK
        // (same TCP segment, or an already-queued chunk) — see hasTrailingData / starttls.js.
        if (this._starttlsHadTrailingData) {
            throw failSTARTTLSInjection();
        }

        // STARTTLS upgrade sequence: detach the plain socket from the parser,
        // wrap it in a TLS socket, then reconnect the new TLS socket to the
        // parser. The plain socket becomes the underlying transport for TLS.
        this.socket.unpipe(this.streamer);

        // Check 2: now that the parser is detached, any bytes still buffered on the plain
        // socket arrived after the OK and were not consumed by the handshake — i.e. injected.
        // This catches late/fragmented injection that the parse-time snapshot cannot see.
        let injectedTail = typeof this.socket.read === 'function' ? this.socket.read() : null;
        /* c8 ignore next 3 */ // late/fragmented post-OK injection is timing-dependent and not deterministically reproducible
        if (injectedTail && injectedTail.length) {
            throw failSTARTTLSInjection();
        }
        let upgraded = await new Promise((resolve, reject) => {
            let socketPlain = this.socket;
            let opts = Object.assign(
                {
                    socket: this.socket,
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
            );
            this.clearSocketHandlers();

            let settled = false;

            // Single settlement path for the upgrade. Every terminal outcome - handshake
            // success, an error on the plain or the TLS socket, the upgrade timeout, an
            // explicit close(), or a streamer error routed here by emitError() - goes through
            // this helper exactly once. It owns clearing the upgrade timer, the exposed
            // rejector, the `upgrading` flag and the temporary handshake handlers, so a late
            // socket event cannot re-enter an already settled upgrade or leave state behind.
            const settle = (err, result) => {
                if (settled) {
                    return;
                }
                settled = true;

                clearTimeout(this.upgradeTimeout);
                this.upgradeTimeout = null;
                this.upgrading = false;
                this._upgradeReject = null;

                socketPlain.removeListener('error', settle);
                if (this.socket && this.socket !== socketPlain) {
                    this.socket.removeListener('error', settle);
                }

                if (err) {
                    clearTimeout(this.connectTimeout);
                    // Preserve the original error, marked as a TLS failure so callers can tell
                    // an upgrade failure from an ordinary command failure.
                    err.tlsFailed = true;
                    this.closeAfter();
                    return reject(err);
                }

                resolve(result);
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
                let err = new Error('Failed to upgrade connection in required time');
                err.code = 'UPGRADE_TIMEOUT';
                settle(err);
            }, UPGRADE_TIMEOUT);
            /* c8 ignore stop */

            this.upgrading = true;
            this.socket = tls.connect(opts, () => {
                try {
                    /* c8 ignore start */ // race: connection closed during the TLS handshake window
                    if (this.isClosed) {
                        let err = new Error('Connection closed during TLS upgrade');
                        err.code = 'NoConnection';
                        return settle(err);
                    }
                    /* c8 ignore stop */

                    // TLS handshake complete. Reconnect the now-encrypted socket
                    // to the IMAP parser stream and record the cipher details.
                    this.secureConnection = true;
                    this.streamer.secureConnection = true;
                    this.socket.pipe(this.streamer);
                    /* c8 ignore next */ // an upgraded TLS socket always exposes getCipher(), so the false fallback is unreachable
                    this.tls = typeof this.socket.getCipher === 'function' ? this.socket.getCipher() : false;
                    if (this.tls) {
                        this.tls.authorized = this.socket.authorized;
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
                    this.emitError(ex);
                }
            });

            // Registered after tls.connect (the TLS socket now exists). This is the ONLY
            // error listener during the handshake window; the generic handlers are installed
            // by setSocketHandlers() inside the success callback above, so a handshake error
            // has a single error path.
            this.socket.once('error', settle);

            this.writeSocket = this.socket;
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

    async setAuthenticationState() {
        this.state = this.states.AUTHENTICATED;
        this.authenticated = true;
        if (this.expectCapabilityUpdate) {
            // update capabilities
            await this.run('CAPABILITY');
        }
    }

    async authenticate() {
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

    beginSession(onUnhandledError) {
        clearTimeout(this.greetingTimeout);
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
                    clearTimeout(this.greetingTimeout);
                    let reject = this.initialReject;
                    this.initialResolve = false;
                    this.initialReject = false;
                    return reject(err);
                }

                onUnhandledError(err);
            });
    }

    async initialOK(message) {
        this.greeting = (message.attributes || [])
            .filter(entry => entry.type === 'TEXT')
            .map(entry => entry.value)
            .filter(entry => entry)
            .join('');

        // ALWAYS emit the error so users can handle it
        this.beginSession(err => this.emitError(err));
    }

    async initialPREAUTH() {
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

    async serverBye(parsed) {
        // Extract BYE reason from response for better error messages
        let reason =
            parsed &&
            parsed.attributes &&
            parsed.attributes
                .filter(val => val.type === 'TEXT')
                .map(val => val.value.trim())
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
    clearCapabilities() {
        this.capabilities.clear();
        this.authCapabilities.clear();
        this.rawCapabilities = null;
    }

    updateCapabilitiesFromRaw(rawCapabilities) {
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

    async sectionCapability(section) {
        this.updateCapabilitiesFromRaw(section);
    }

    async untaggedCapability(untagged) {
        this.updateCapabilitiesFromRaw(untagged.attributes);
    }

    async untaggedExists(untagged) {
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
    async notifyExpunge(payload) {
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

    async untaggedExpunge(untagged) {
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
            let payload = {
                path: this.mailbox.path,
                seq,
                vanished: false
            };

            await this.notifyExpunge(payload);
        }
    }

    async untaggedVanished(untagged, mailbox) {
        mailbox = mailbox || this.mailbox;
        if (!mailbox) {
            // mailbox closed, ignore
            return;
        }

        let tags = [];
        let uids = false;

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
            let payload = {
                path: mailbox.path,
                uid,
                vanished: true,
                earlier: tags.includes('EARLIER')
            };

            await this.notifyExpunge(payload);
        }
    }

    async untaggedFetch(untagged, mailbox) {
        mailbox = mailbox || this.mailbox;
        if (!mailbox) {
            // mailbox closed, ignore
            return;
        }

        let message = await formatMessageResponse(untagged, mailbox);
        if (message.flags) {
            let updateEvent = {
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

            this.emit('flags', updateEvent);
        }
    }

    async ensureSelectedMailbox(path) {
        if (!path) {
            return false;
        }

        if (!this.mailbox || !comparePaths(this, this.mailbox.path, path)) {
            return await this.mailboxOpen(path);
        }

        return true;
    }

    // Normalizes a message range from various input formats into an IMAP-compatible
    // sequence string (e.g., "1:5,7,10:*"). Handles: numbers, "*", {all:true},
    // {uid:value}, search query objects (resolved via SEARCH), and arrays of numbers.
    async resolveRange(range, options) {
        if (typeof range === 'number' || typeof range === 'bigint') {
            range = range.toString();
        }

        // Replace "*" with the actual message count. Some servers reject bare "*"
        // in certain commands, and this also forces a sequence query (not UID).
        if (range === '*') {
            if (!this.mailbox.exists) {
                return false;
            }
            range = this.mailbox.exists.toString();
            options.uid = false; // sequence query
        }

        if (range && typeof range === 'object' && !Array.isArray(range)) {
            if (range.all && Object.keys(range).length === 1) {
                range = '1:*';
            } else if (range.uid && Object.keys(range).length === 1) {
                range = range.uid;
                options.uid = true;
            } else {
                // Arbitrary search query object: run SEARCH to resolve it into
                // a set of UIDs, then pack into a compact range string.
                options.uid = true; // force UIDs instead of sequence numbers
                range = await this.run('SEARCH', range, options);
                if (range && range.length) {
                    range = packMessageRange(range);
                }
            }
        }

        if (Array.isArray(range)) {
            range = range.join(',');
        }

        if (!range) {
            return false;
        }

        return range;
    }

    // The single definition of "the connection is not free". A held or queued mailbox lock, a
    // command in flight or queued, and an open download stream all mean a caller is
    // mid-sequence: starting IDLE there injects an IDLE/DONE round trip - or, with
    // `missingIdleCommand` set to SELECT or STATUS, a mailbox poll - between two of that
    // caller's own commands. Every one of those states ends by calling autoidle() again, so
    // declining while busy postpones IDLE, it never cancels it.
    connectionBusy() {
        return !!(this.currentLock || this.locks.length || this.currentRequest || this.requestQueue.length || this._openDownloads);
    }

    // Timer process-liveness policy: connection establishment and greeting deadlines keep the
    // process alive, because a caller is waiting on connect() to settle. Background timers
    // (auto-IDLE, IDLE restart, fallback polling, throttle back-off, the held-lock diagnostic) are
    // unref'd, so an otherwise idle process is not held open by them. Every timer is still cleared
    // explicitly on close().
    autoidle() {
        clearTimeout(this.idleStartTimer);
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
     * @returns {Promise<void>}
     * @throws Will throw an error if connection or authentication fails
     * @example
     * let client = new ImapFlow({...});
     * await client.connect();
     */
    async connect() {
        if (this._connectCalled) {
            // Prevent re-using ImapFlow instances by allowing to call connect just once.
            throw new Error('Can not re-use ImapFlow instance');
        }
        this._connectCalled = true;

        // One deadline for the whole attempt, started before anything is resolved or negotiated.
        // Proxy DNS and proxy negotiation used to run entirely outside the timer, so a stalled
        // proxy could hang far beyond the documented connectionTimeout.
        let deadline = new ConnectionDeadline(this.options.connectionTimeout);

        let connector = this.secureConnection ? tls : net;

        let opts = Object.assign(
            {
                host: this.host,
                servername: this.servername,
                port: this.port
            },
            this.options.tls || {}
        );

        this.untaggedHandlers.OK = (...args) => this.initialOK(...args);
        this.untaggedHandlers.BYE = (...args) => this.serverBye(...args);
        this.untaggedHandlers.PREAUTH = (...args) => this.initialPREAUTH(...args);

        this.untaggedHandlers.CAPABILITY = (...args) => this.untaggedCapability(...args);
        this.sectionHandlers.CAPABILITY = (...args) => this.sectionCapability(...args);

        this.untaggedHandlers.EXISTS = (...args) => this.untaggedExists(...args);
        this.untaggedHandlers.EXPUNGE = (...args) => this.untaggedExpunge(...args);

        // these methods take an optional second argument, so make sure that some random IMAP tag is not used as the second argument
        this.untaggedHandlers.FETCH = untagged => this.untaggedFetch(untagged);
        this.untaggedHandlers.VANISHED = untagged => this.untaggedVanished(untagged);

        let socket = false;
        if (this.options.proxy) {
            try {
                socket = await proxyConnection(this.log, this.options.proxy, this.host, this.port, { deadline });
                if (!socket) {
                    throw new Error('Failed to setup proxy connection');
                }
            } catch (err) {
                // Logged here rather than relying on proxy-connection.js, which only reports
                // failures from inside the two connect helpers. An unsupported scheme, a proxy URL
                // that will not parse and a deadline that expired before the connect started all
                // reject before any logging happens there, so this is the one place that sees
                // every way proxy setup can fail.
                this.log.error({ msg: 'Failed to setup proxy connection', err, cid: this.id });

                if (err.code === 'CONNECT_TIMEOUT') {
                    // The shared deadline expired during proxy setup. Report it as the documented
                    // connection timeout rather than as a generic proxy failure.
                    throw err;
                }
                let error = new Error('Failed to setup proxy connection');
                error.code = err.code || 'ProxyError';
                error._err = err;
                throw error;
            }
        }

        let connectPromise = new Promise((resolve, reject) => {
            // Whatever the proxy phase already used is gone from the budget
            this.connectTimeout = setTimeout(() => {
                let err = deadline.error();
                this.log.error({ err, cid: this.id });
                this.closeAfter();
                reject(err);
            }, deadline.remaining());

            let onConnect = () => {
                try {
                    clearTimeout(this.connectTimeout);

                    // ImapFlow now owns the socket; drop the proxy's early error handler
                    // (its "before connection setup" message no longer applies).
                    detachEarlyErrorHandler(socket);

                    this.configureSocket(this.socket);

                    this.greetingTimeout = setTimeout(() => {
                        let err = new Error(
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

                    this.tls = typeof this.socket.getCipher === 'function' ? this.socket.getCipher() : false;

                    let logInfo = {
                        src: 'connection',
                        msg: `Established ${this.tls ? 'secure ' : ''}TCP connection`,
                        cid: this.id,
                        secure: !!this.tls,
                        host: this.host,
                        servername: this.servername,
                        port: this.socket.remotePort,
                        address: this.socket.remoteAddress,
                        localAddress: this.socket.localAddress,
                        localPort: this.socket.localPort
                    };

                    if (this.tls) {
                        logInfo.authorized = this.tls.authorized = this.socket.authorized;
                        /* c8 ignore next */ // cipher.standardName is present on modern Node, so the .name fallback rarely runs
                        logInfo.algo = this.tls.standardName || this.tls.name;
                        logInfo.version = this.tls.version;
                    }

                    this.log.info(logInfo);

                    this.setSocketHandlers();
                    this.setEventHandlers();
                    this.socket.pipe(this.streamer);

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
            this._connectErrorHandler = err => {
                clearTimeout(this.connectTimeout);
                clearTimeout(this.greetingTimeout);
                this.closeAfter();
                this.log.error({ err, cid: this.id });
                reject(err);
            };
            this.socket.on('error', this._connectErrorHandler);
        });

        // Prevent unhandled promise rejection if close() rejects the connect
        // promise synchronously. The rejection still propagates to the caller.
        connectPromise.catch(noop);

        await connectPromise;
    }

    /**
     * Graceful connection close by sending logout command to server. TCP connection is closed once command is finished.
     *
     * @return {Promise<void>}
     * @example
     * let client = new ImapFlow({...});
     * await client.connect();
     * ...
     * await client.logout();
     */
    async logout() {
        return await this.run('LOGOUT');
    }

    /**
     * Close the TCP connection.
     * Unlike `close()`, return immediately from this function, allowing the
     * caller function to proceed, and run `close()` function afterwards.
     */
    closeAfter() {
        setImmediate(() => this.close());
    }

    // Builds the standard "connection not available" error, optionally annotated with the
    // server's BYE reason. Single source of truth so every NoConnection rejection is consistent.
    createNoConnectionError(byeReason) {
        const error = new Error('Connection not available');
        error.code = 'NoConnection';
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
    close() {
        try {
            // clear pending timers
            clearTimeout(this.idleStartTimer);
            clearTimeout(this.upgradeTimeout);
            clearTimeout(this.connectTimeout);
            clearTimeout(this.greetingTimeout);

            // Abort every in-flight throttle back-off so each waiter unblocks and its request is
            // settled promptly rather than after the full delay.
            for (let entry of this._throttleWaits) {
                clearTimeout(entry.timer);
                entry.resolve(true);
            }
            this._throttleWaits.clear();

            this.usable = false;
            // close() takes over ownership of the idling state: dropping the session token means a
            // poll or IDLE that unwinds after this point sees that it no longer owns the flag and
            // leaves it alone (see claimIdling() in commands/idle.js).
            this._idleSession = null;
            this.idling = false;

            // An in-flight STARTTLS upgrade has to be settled through its own single settlement
            // path, otherwise the upgrade promise (and the session it belongs to) stays pending
            // for the lifetime of the process.
            if (typeof this._upgradeReject === 'function') {
                let reject = this._upgradeReject;
                this._upgradeReject = null;
                let err = new Error('Connection closed during TLS upgrade');
                err.code = 'NoConnection';
                reject(err);
            }

            if (typeof this.initialReject === 'function' && !this.options.verifyOnly) {
                clearTimeout(this.greetingTimeout);
                let reject = this.initialReject;
                this.initialResolve = false;
                this.initialReject = false;
                let err = new Error('Unexpected close');
                /* c8 ignore next */ // closing a pending connect over an already-secure socket (the TLS branch) is not separately exercised
                err.code = `ClosedAfterConnect${this.secureConnection ? 'TLS' : 'Text'}`;
                // Surface the server's BYE reason (e.g. "Too many connections") when the
                // connection was closed by an untagged BYE, so the caller sees why.
                if (this.byeReason) {
                    err.reason = this.byeReason;
                }
                // Synchronous rejection is safe: connectPromise.catch(noop) is already
                // attached, so the rejection is observed immediately. close() is synchronous,
                // so all cleanup completes before any microtask rejection handler runs.
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
            let closedMailbox = false;
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
            let pendingRequests = [];

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

            // Helper to create connection error (delegates to the shared builder)
            const createNoConnectionError = byeReason => this.createNoConnectionError(byeReason);

            // Reject pending requests and locks synchronously. Each exec() and
            // getMailboxLock() promise already has .catch(noop) attached, so the
            // rejection is observed immediately and will not trigger
            // unhandledRejection. close() is synchronous, so all remaining cleanup
            // runs before any microtask rejection handler fires.
            let byeReason = this.byeReason;

            for (let request of pendingRequests) {
                request.reject(createNoConnectionError(byeReason));
            }

            // Clear current lock - holder will see errors when they try operations.
            // Also clear the held-lock diagnostic timer so it doesn't fire post-close.
            if (this.currentLock && this.currentLock.heldWarnTimer) {
                clearTimeout(this.currentLock.heldWarnTimer);
                this.currentLock.heldWarnTimer = null;
            }
            this.currentLock = false;

            if (this.locks && this.locks.length) {
                let pendingLocks = this.locks.splice(0); // Take all locks and clear the array
                for (let lock of pendingLocks) {
                    if (lock.acquireTimer) {
                        clearTimeout(lock.acquireTimer);
                        lock.acquireTimer = null;
                    }
                    if (typeof lock.reject === 'function') {
                        lock.reject(createNoConnectionError(byeReason));
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
     * @typedef {Object} QuotaResponse
     * @global
     * @property {String} path=INBOX mailbox path this quota applies to
     * @property {Object} [storage] Storage quota if provided by server
     * @property {Number} [storage.used] used storage in bytes
     * @property {Number} [storage.limit] total storage available
     * @property {Object} [messages] Message count quota if provided by server
     * @property {Number} [messages.used] stored messages
     * @property {Number} [messages.limit] maximum messages allowed
     */

    /**
     * Returns current quota
     *
     * @param {String} [path] Optional mailbox path if you want to check quota for specific folder
     * @returns {Promise<QuotaResponse|Boolean>} Quota information or `false` if QUOTA extension is not supported or requested path does not exist
     *
     * @example
     * let quota = await client.getQuota();
     * console.log(quota.storage.used, quota.storage.limit)
     */
    async getQuota(path) {
        path = path || 'INBOX';
        return await this.run('QUOTA', path);
    }

    /**
     * @typedef {Object} ListResponse
     * @global
     * @property {String} path mailbox path (unicode string)
     * @property {String} pathAsListed mailbox path as listed in the LIST/LSUB response
     * @property {String} name mailbox name (last part of path after delimiter)
     * @property {String} delimiter mailbox path delimiter, usually "." or "/"
     * @property {String[]} parent An array of parent folder names. All names are in unicode
     * @property {String} parentPath Same as `parent`, but as a complete string path (unicode string)
     * @property {Set<string>} flags a set of flags for this mailbox
     * @property {String} specialUse one of special-use flags (if applicable): "\All", "\Archive", "\Drafts", "\Flagged", "\Junk", "\Sent", "\Trash". Additionally INBOX has non-standard "\Inbox" flag set
     * @property {String} [specialUseSource] how `specialUse` was determined: `"user"` (from `specialUseHints`), `"extension"` (SPECIAL-USE or XLIST flag reported by the server) or `"name"` (matched against known localized folder names)
     * @property {Boolean} listed `true` if mailbox was found from the output of LIST command
     * @property {Boolean} subscribed `true` if the mailbox is subscribed - reported by LSUB or by LIST RETURN (SUBSCRIBED) on LIST-EXTENDED/IMAP4rev2 servers. Servers that answer neither report no subscription state at all, and every mailbox is then assumed to be subscribed
     * @property {StatusObject} [status] If `statusQuery` was used, then this value includes the status response
     */

    /**
     * @typedef {Object} ListOptions
     * @global
     * @property {Object} [statusQuery] request status items for every listed entry
     * @property {Boolean} [statusQuery.messages] if `true` request count of messages
     * @property {Boolean} [statusQuery.recent] if `true` request count of messages with \\Recent tag
     * @property {Boolean} [statusQuery.uidNext] if `true` request predicted next UID
     * @property {Boolean} [statusQuery.uidValidity] if `true` request mailbox `UIDVALIDITY` value
     * @property {Boolean} [statusQuery.unseen] if `true` request count of unseen messages
     * @property {Boolean} [statusQuery.highestModseq] if `true` request last known modseq value
     * @property {Boolean} [statusQuery.size] if `true` request total mailbox size in octets (requires STATUS=SIZE or IMAP4rev2)
     * @property {Boolean} [statusQuery.deleted] if `true` request count of messages with \\Deleted flag (requires IMAP4rev2)
     * @property {Object} [specialUseHints] set specific paths as special use folders, this would override special use flags provided from the server
     * @property {String} [specialUseHints.sent] Path to "Sent Mail" folder
     * @property {String} [specialUseHints.trash] Path to "Trash" folder
     * @property {String} [specialUseHints.junk] Path to "Junk Mail" folder
     * @property {String} [specialUseHints.drafts] Path to "Drafts" folder
     * @property {String} [specialUseHints.archive] Path to "Archive" folder
     */

    /**
     * Lists available mailboxes as an Array
     *
     * @param {ListOptions} [options] defines additional listing options
     * @returns {Promise<ListResponse[]>} An array of ListResponse objects
     *
     * @example
     * let list = await client.list();
     * list.forEach(mailbox=>console.log(mailbox.path));
     */
    async list(options) {
        options = options || {};
        let folders = await this.run('LIST', '', '*', options);
        this.folders = new Map(folders.map(folder => [folder.path, folder]));
        return folders;
    }

    /**
     * @typedef {Object} ListTreeResponse
     * @global
     * @property {Boolean} root If `true` then this is root node without any additional properties besides *folders*
     * @property {String} path mailbox path
     * @property {String} name mailbox name (last part of path after delimiter)
     * @property {String} delimiter mailbox path delimiter, usually "." or "/"
     * @property {Set<string>} flags list of flags for this mailbox
     * @property {String} specialUse one of special-use flags (if applicable): "\All", "\Archive", "\Drafts", "\Flagged", "\Junk", "\Sent", "\Trash". Additionally INBOX has non-standard "\Inbox" flag set
     * @property {Boolean} listed `true` if mailbox was found from the output of LIST command
     * @property {Boolean} subscribed `true` if the mailbox is subscribed - reported by LSUB or by LIST RETURN (SUBSCRIBED) on LIST-EXTENDED/IMAP4rev2 servers. Servers that answer neither report no subscription state at all, and every mailbox is then assumed to be subscribed
     * @property {Boolean} disabled If `true` then this mailbox can not be selected in the UI
     * @property {ListTreeResponse[]} folders An array of subfolders
     * @property {StatusObject} [status] If `statusQuery` was used, then this value includes the status response
     */

    /**
     * Lists available mailboxes as a tree structured object
     *
     * @param {ListOptions} [options] defines additional listing options
     * @returns {Promise<ListTreeResponse>} Tree structured object
     *
     * @example
     * let tree = await client.listTree();
     * tree.folders.forEach(mailbox=>console.log(mailbox.path));
     */
    async listTree(options) {
        options = options || {};
        let folders = await this.run('LIST', '', '*', options);
        this.folders = new Map(folders.map(folder => [folder.path, folder]));
        return getFolderTree(folders);
    }

    /**
     * Performs a no-op call against server
     * @returns {Promise<void>}
     */
    async noop() {
        await this.run('NOOP');
    }

    /**
     * @typedef {Object} MailboxCreateResponse
     * @global
     * @property {String} path full mailbox path
     * @property {String} [mailboxId] unique mailbox ID if server supports `OBJECTID` extension (currently Yahoo and some others)
     * @property {Boolean} created If `true` then mailbox was created otherwise it already existed
     */

    /**
     * Creates a new mailbox folder and sets up subscription for the created mailbox. Throws on error.
     *
     * @param {string|array} path Full mailbox path. Unicode is allowed. If value is an array then it is joined using current delimiter symbols. Namespace prefix is added automatically if required.
     * @returns {Promise<MailboxCreateResponse>} Mailbox info
     * @throws Will throw an error if mailbox can not be created
     *
     * @example
     * let info = await client.mailboxCreate(['parent', 'child']);
     * console.log(info.path);
     * // "INBOX.parent.child" // assumes "INBOX." as namespace prefix and "." as delimiter
     */
    async mailboxCreate(path) {
        return await this.run('CREATE', path);
    }

    /**
     * @typedef {Object} MailboxRenameResponse
     * @global
     * @property {String} path full mailbox path that was renamed
     * @property {String} newPath new full mailbox path
     */

    /**
     * Renames a mailbox. Throws on error.
     *
     * @param {string|array} path  Path for the mailbox to rename. Unicode is allowed. If value is an array then it is joined using current delimiter symbols. Namespace prefix is added automatically if required.
     * @param {string|array} newPath New path for the mailbox
     * @returns {Promise<MailboxRenameResponse>} Mailbox info
     * @throws Will throw an error if mailbox does not exist or can not be renamed
     *
     * @example
     * let info = await client.mailboxRename('parent.child', 'Important stuff ❗️');
     * console.log(info.newPath);
     * // "INBOX.Important stuff ❗️" // assumes "INBOX." as namespace prefix
     */
    async mailboxRename(path, newPath) {
        return await this.run('RENAME', path, newPath);
    }

    /**
     * @typedef {Object} MailboxDeleteResponse
     * @global
     * @property {String} path full mailbox path that was deleted
     */

    /**
     * Deletes a mailbox. Throws on error.
     *
     * @param {string|array} path Path for the mailbox to delete. Unicode is allowed. If value is an array then it is joined using current delimiter symbols. Namespace prefix is added automatically if required.
     * @returns {Promise<MailboxDeleteResponse>} Mailbox info
     * @throws Will throw an error if mailbox does not exist or can not be deleted
     *
     * @example
     * let info = await client.mailboxDelete('Important stuff ❗️');
     * console.log(info.path);
     * // "INBOX.Important stuff ❗️" // assumes "INBOX." as namespace prefix
     */
    async mailboxDelete(path) {
        return await this.run('DELETE', path);
    }

    /**
     * Subscribes to a mailbox
     *
     * @param {string|array} path Path for the mailbox to subscribe to. Unicode is allowed. If value is an array then it is joined using current delimiter symbols. Namespace prefix is added automatically if required.
     * @returns {Promise<Boolean>} `true` if subscription operation succeeded, `false` otherwise
     *
     * @example
     * await client.mailboxSubscribe('Important stuff ❗️');
     */
    async mailboxSubscribe(path) {
        return await this.run('SUBSCRIBE', path);
    }

    /**
     * Unsubscribes from a mailbox
     *
     * @param {string|array} path **Path for the mailbox** to unsubscribe from. Unicode is allowed. If value is an array then it is joined using current delimiter symbols. Namespace prefix is added automatically if required.
     * @returns {Promise<Boolean>} `true` if unsubscription operation succeeded, `false` otherwise
     *
     * @example
     * await client.mailboxUnsubscribe('Important stuff ❗️');
     */
    async mailboxUnsubscribe(path) {
        return await this.run('UNSUBSCRIBE', path);
    }

    /**
     * Opens a mailbox to access messages. You can perform message operations only against an opened mailbox.
     * Using {@link module:imapflow~ImapFlow#getMailboxLock|getMailboxLock()} instead of `mailboxOpen()` is preferred. Both do the same thing
     * but next `getMailboxLock()` call is not executed until previous one is released.
     *
     * @param {string|array} path **Path for the mailbox** to open
     * @param {Object} [options] optional options
     * @param {Boolean} [options.readOnly=false] If `true` then opens mailbox in read-only mode. You can still try to perform write operations but these would probably fail.
     * @returns {Promise<MailboxObject>} Mailbox info
     * @throws Will throw an error if mailbox does not exist or can not be opened
     *
     * @example
     * let mailbox = await client.mailboxOpen('Important stuff ❗️');
     * console.log(mailbox.exists);
     * // 125
     */
    async mailboxOpen(path, options) {
        return await this.run('SELECT', path, options);
    }

    /**
     * Closes a previously opened mailbox
     *
     * @returns {Promise<Boolean>} Did the operation succeed or not
     *
     * @example
     * let mailbox = await client.mailboxOpen('INBOX');
     * await client.mailboxClose();
     */
    async mailboxClose() {
        return await this.run('CLOSE');
    }

    /**
     * @typedef {Object} StatusObject
     * @global
     * @property {String} path full mailbox path that was checked
     * @property {Number} [messages] Count of messages
     * @property {Number} [recent] Count of messages with \\Recent tag
     * @property {Number} [uidNext] Predicted next UID
     * @property {BigInt} [uidValidity] Mailbox `UIDVALIDITY` value
     * @property {Number} [unseen] Count of unseen messages
     * @property {BigInt} [highestModseq] Last known modseq value (if CONDSTORE extension is enabled)
     * @property {Number} [size] Total size of the mailbox in octets (only if requested and the server supports STATUS=SIZE or IMAP4rev2)
     * @property {Number} [deleted] Count of messages with \\Deleted flag (only if requested and IMAP4rev2 is active)
     */

    /**
     * Requests the status of the indicated mailbox. Only requested status values will be returned.
     *
     * @param {String} path mailbox path to check for (unicode string)
     * @param {Object} query defines requested status items
     * @param {Boolean} query.messages if `true` request count of messages
     * @param {Boolean} query.recent if `true` request count of messages with \\Recent tag
     * @param {Boolean} query.uidNext if `true` request predicted next UID
     * @param {Boolean} query.uidValidity if `true` request mailbox `UIDVALIDITY` value
     * @param {Boolean} query.unseen if `true` request count of unseen messages
     * @param {Boolean} query.highestModseq if `true` request last known modseq value
     * @param {Boolean} query.size if `true` request total mailbox size in octets (requires STATUS=SIZE or IMAP4rev2)
     * @param {Boolean} query.deleted if `true` request count of messages with \\Deleted flag (requires IMAP4rev2)
     * @returns {Promise<StatusObject>} status of the indicated mailbox
     *
     * @example
     * let status = await client.status('INBOX', {unseen: true});
     * console.log(status.unseen);
     * // 123
     */
    async status(path, query) {
        return await this.run('STATUS', path, query);
    }

    /**
     * Starts listening for new or deleted messages from the currently opened mailbox. Only required if {@link ImapFlow#disableAutoIdle} is set to `true`
     * otherwise IDLE is started by default on connection inactivity. NB! If `idle()` is called manually then it does not
     * return until IDLE is finished which means you would have to call some other command out of scope.
     *
     * @returns {Promise<Boolean>} Did the operation succeed or not
     *
     * @example
     * let mailbox = await client.mailboxOpen('INBOX');
     *
     * await client.idle();
     */
    async idle() {
        if (!this.idling) {
            return await this.run('IDLE', this.maxIdleTime);
        }
    }

    /**
     * Sequence range string. Separate different values with commas, number ranges with colons and use \\* as the placeholder for the newest message in mailbox
     * @typedef {String} SequenceString
     * @global
     * @example
     * "1:*" // for all messages
     * "1,2,3" // for messages 1, 2 and 3
     * "1,2,4:6" // for messages 1,2,4,5,6
     * "*" // for the newest message
     */

    /**
     * IMAP search query options. By default all conditions must match. In case of `or` query term at least one condition must match.
     * @typedef {Object} SearchObject
     * @global
     * @property {SequenceString} [seq] message ordering sequence range
     * @property {Boolean} [answered] Messages with (value is `true`) or without (value is `false`) \\Answered flag
     * @property {Boolean} [deleted] Messages with (value is `true`) or without (value is `false`) \\Deleted flag
     * @property {Boolean} [draft] Messages with (value is `true`) or without (value is `false`) \\Draft flag
     * @property {Boolean} [flagged] Messages with (value is `true`) or without (value is `false`) \\Flagged flag
     * @property {Boolean} [seen] Messages with (value is `true`) or without (value is `false`) \\Seen flag
     * @property {Boolean} [all] If `true` matches all messages
     * @property {Boolean} [new] If `true` matches messages that have the \\Recent flag set but not the \\Seen flag
     * @property {Boolean} [old] If `true` matches messages that do not have the \\Recent flag set
     * @property {Boolean} [recent] If `true` matches messages that have the \\Recent flag set
     * @property {String} [from] Matches From: address field
     * @property {String} [to] Matches To: address field
     * @property {String} [cc] Matches Cc: address field
     * @property {String} [bcc] Matches Bcc: address field
     * @property {String} [body] Matches message body
     * @property {String} [subject] Matches message subject
     * @property {Number} [larger] Matches messages larger than value
     * @property {Number} [smaller] Matches messages smaller than value
     * @property {SequenceString} [uid] UID sequence range
     * @property {BigInt} [modseq] Matches messages with modseq higher than value
     * @property {String} [emailId] unique email ID. Only used if server supports `OBJECTID` or `X-GM-EXT-1` extensions
     * @property {String} [threadId] unique thread ID. Only used if server supports `OBJECTID` or `X-GM-EXT-1` extensions
     * @property {Date|string} [before] Matches messages received before date
     * @property {Date|string} [on] Matches messages received on date (ignores time)
     * @property {Date|string} [since] Matches messages received after date
     * @property {Date|string} [sentBefore] Matches messages sent before date
     * @property {Date|string} [sentOn] Matches messages sent on date (ignores time)
     * @property {Date|string} [sentSince] Matches messages sent after date
     * @property {String} [keyword] Matches messages that have the custom flag set
     * @property {String} [unKeyword] Matches messages that do not have the custom flag set
     * @property {Object.<string, Boolean|String>} [header] Matches messages with header key set if value is `true` (**NB!** not supported by all servers) or messages where header partially matches a string value
     * @property {SearchObject} [not] A {@link SearchObject} object. It must not match.
     * @property {SearchObject[]} [or] An array of 2 or more {@link SearchObject} objects. At least one of these must match
     */

    /**
     * Sets flags for a message or message range
     *
     * @param {SequenceString | Number[] | SearchObject} range Range to filter the messages
     * @param {string[]} flags Array of flags to set. Only flags that are permitted to set are used, other flags are ignored
     * @param {Object} [options]
     * @param {Boolean} [options.uid] If `true` then uses UID {@link SequenceString} instead of sequence numbers
     * @param {BigInt} [options.unchangedSince] If set then only messages with a lower or equal `modseq` value are updated. Ignored if server does not support `CONDSTORE` extension.
     * @param {Boolean} [options.useLabels=false] If true then update Gmail labels instead of message flags
     * @returns {Promise<Boolean>} Did the operation succeed or not
     *
     * @example
     * let mailbox = await client.mailboxOpen('INBOX');
     * // mark all unseen messages as seen (and remove other flags)
     * await client.messageFlagsSet({seen: false}, ['\Seen]);
     */
    async messageFlagsSet(range, flags, options) {
        options = options || {};

        range = await this.resolveRange(range, options);
        if (!range) {
            return false;
        }

        let queryOpts = Object.assign(
            {
                operation: 'set'
            },
            options
        );

        return await this.run('STORE', range, flags, queryOpts);
    }

    /**
     * Adds flags for a message or message range
     *
     * @param {SequenceString | Number[] | SearchObject} range Range to filter the messages
     * @param {string[]} flags Array of flags to set. Only flags that are permitted to set are used, other flags are ignored
     * @param {Object} [options]
     * @param {Boolean} [options.uid] If `true` then uses UID {@link SequenceString} instead of sequence numbers
     * @param {BigInt} [options.unchangedSince] If set then only messages with a lower or equal `modseq` value are updated. Ignored if server does not support `CONDSTORE` extension.
     * @param {Boolean} [options.useLabels=false] If true then update Gmail labels instead of message flags
     * @returns {Promise<Boolean>} Did the operation succeed or not
     *
     * @example
     * let mailbox = await client.mailboxOpen('INBOX');
     * // mark all unseen messages as seen (and keep other flags as is)
     * await client.messageFlagsAdd({seen: false}, ['\Seen]);
     */
    async messageFlagsAdd(range, flags, options) {
        options = options || {};

        range = await this.resolveRange(range, options);
        if (!range) {
            return false;
        }

        let queryOpts = Object.assign(
            {
                operation: 'add'
            },
            options
        );

        return await this.run('STORE', range, flags, queryOpts);
    }

    /**
     * Remove specific flags from a message or message range
     *
     * @param {SequenceString | Number[] | SearchObject} range Range to filter the messages
     * @param {string[]} flags Array of flags to remove. Only flags that are permitted to set are used, other flags are ignored
     * @param {Object} [options]
     * @param {Boolean} [options.uid] If `true` then uses UID {@link SequenceString} instead of sequence numbers
     * @param {BigInt} [options.unchangedSince] If set then only messages with a lower or equal `modseq` value are updated. Ignored if server does not support `CONDSTORE` extension.
     * @param {Boolean} [options.useLabels=false] If true then update Gmail labels instead of message flags
     * @returns {Promise<Boolean>} Did the operation succeed or not
     *
     * @example
     * let mailbox = await client.mailboxOpen('INBOX');
     * // mark all seen messages as unseen by removing \\Seen flag
     * await client.messageFlagsRemove({seen: true}, ['\Seen]);
     */
    async messageFlagsRemove(range, flags, options) {
        options = options || {};

        range = await this.resolveRange(range, options);
        if (!range) {
            return false;
        }

        let queryOpts = Object.assign(
            {
                operation: 'remove'
            },
            options
        );

        return await this.run('STORE', range, flags, queryOpts);
    }

    /**
     * Sets a colored flag for an email. Only supported by mail clients like Apple Mail
     *
     * @param {SequenceString | Number[] | SearchObject} range Range to filter the messages
     * @param {string} color The color to set. One of 'red', 'orange', 'yellow', 'green', 'blue', 'purple', and 'grey'
     * @param {Object} [options]
     * @param {Boolean} [options.uid] If `true` then uses UID {@link SequenceString} instead of sequence numbers
     * @param {BigInt} [options.unchangedSince] If set then only messages with a lower or equal `modseq` value are updated. Ignored if server does not support `CONDSTORE` extension.
     * @returns {Promise<Boolean>} Did the operation succeed or not
     *
     * @example
     * let mailbox = await client.mailboxOpen('INBOX');
     * // add a purple flag for all emails
     * await client.setFlagColor('1:*', 'Purple');
     */
    async setFlagColor(range, color, options) {
        options = options || {};

        range = await this.resolveRange(range, options);
        if (!range) {
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

            addResults = await this.run('STORE', range, flagChanges.add, queryOpts);
        }

        if (flagChanges.remove && flagChanges.remove.length) {
            let queryOpts = Object.assign(
                {
                    operation: 'remove'
                },
                options,
                { useLabels: false } // override if set
            );

            removeResults = await this.run('STORE', range, flagChanges.remove, queryOpts);
        }

        return addResults || removeResults || false;
    }

    /**
     * Delete messages from the currently opened mailbox. Method does not indicate info about deleted messages,
     * instead you should be using {@link ImapFlow#expunge} event for this
     *
     * @param {SequenceString | Number[] | SearchObject} range Range to filter the messages
     * @param {Object} [options]
     * @param {Boolean} [options.uid] If `true` then uses UID {@link SequenceString} instead of sequence numbers
     * @returns {Promise<Boolean>} Did the operation succeed or not
     *
     * @example
     * let mailbox = await client.mailboxOpen('INBOX');
     * // delete all seen messages
     * await client.messageDelete({seen: true});
     */
    async messageDelete(range, options) {
        options = options || {};
        range = await this.resolveRange(range, options);
        if (!range) {
            return false;
        }
        return await this.run('EXPUNGE', range, options);
    }

    /**
     * @typedef {Object} AppendResponseObject
     * @global
     * @property {String} destination full mailbox path where the message was uploaded to
     * @property {BigInt} [uidValidity] mailbox `UIDVALIDITY` if server has `UIDPLUS` extension enabled
     * @property {Number} [uid] UID of the uploaded message if server has `UIDPLUS` extension enabled
     * @property {Number} [seq] sequence number of the uploaded message if path is currently selected mailbox
     */

    /**
     * Appends a new message to a mailbox
     *
     * @param {String} path Mailbox path to upload the message to (unicode string)
     * @param {string|Buffer} content RFC822 formatted email message
     * @param {string[]} [flags] an array of flags to be set for the uploaded message
     * @param {Date|string} [idate=now] internal date to be set for the message
     * @returns {Promise<AppendResponseObject>} info about uploaded message
     *
     * @example
     * await client.append('INBOX', rawMessageBuffer, ['\\Seen'], new Date(2000, 1, 1));
     */
    async append(path, content, flags, idate) {
        return (await this.run('APPEND', path, content, flags, idate)) || false;
    }

    /**
     * @typedef {Object} CopyResponseObject
     * @global
     * @property {String} path path of source mailbox
     * @property {String} destination path of destination mailbox
     * @property {BigInt} [uidValidity] destination mailbox `UIDVALIDITY` if server has `UIDPLUS` extension enabled
     * @property {Map<number, number>} [uidMap] Map of UID values (if server has `UIDPLUS` extension enabled) where key is UID in source mailbox and value is the UID for the same message in destination mailbox
     */

    /**
     * Copies messages from current mailbox to destination mailbox
     *
     * @param {SequenceString | Number[] | SearchObject} range Range of messages to copy
     * @param {String} destination Mailbox path to copy the messages to
     * @param {Object} [options]
     * @param {Boolean} [options.uid] If `true` then uses UID {@link SequenceString} instead of sequence numbers
     * @returns {Promise<CopyResponseObject>} info about copies messages
     *
     * @example
     * await client.mailboxOpen('INBOX');
     * // copy all messages to a mailbox called "Backup" (must exist)
     * let result = await client.messageCopy('1:*', 'Backup');
     * console.log('Copied %s messages', result.uidMap.size);
     */
    async messageCopy(range, destination, options) {
        options = options || {};
        range = await this.resolveRange(range, options);
        if (!range) {
            return false;
        }
        return await this.run('COPY', range, destination, options);
    }

    /**
     * Moves messages from current mailbox to destination mailbox
     *
     * @param {SequenceString | Number[] | SearchObject} range Range of messages to move
     * @param {String} destination Mailbox path to move the messages to
     * @param {Object} [options]
     * @param {Boolean} [options.uid] If `true` then uses UID {@link SequenceString} instead of sequence numbers
     * @returns {Promise<CopyResponseObject>} info about moved messages
     *
     * @example
     * await client.mailboxOpen('INBOX');
     * // move all messages to a mailbox called "Trash" (must exist)
     * let result = await client.messageMove('1:*', 'Trash');
     * console.log('Moved %s messages', result.uidMap.size);
     */
    async messageMove(range, destination, options) {
        options = options || {};
        range = await this.resolveRange(range, options);
        if (!range) {
            return false;
        }
        return await this.run('MOVE', range, destination, options);
    }

    /**
     * Search messages from the currently opened mailbox
     *
     * @param {SearchObject} query Query to filter the messages
     * @param {Object} [options]
     * @param {Boolean} [options.uid] If `true` then returns UID numbers instead of sequence numbers
     * @returns {Promise<Number[]>} An array of sequence or UID numbers
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
    async search(query, options) {
        if (!this.mailbox) {
            // no mailbox selected, nothing to do
            return;
        }

        const result = (await this.run('SEARCH', query, options)) || false;

        // When returnOptions was requested but server lacked ESEARCH capability,
        // search.js returns a plain number[]. Derive ESearchResult client-side.
        if (options && options.returnOptions && Array.isArray(result)) {
            const arr = result;
            // Normalize to uppercase so callers can use mixed-case strings like 'count'
            const normalizedOptions = options.returnOptions.map(o => (typeof o === 'string' ? o.toUpperCase() : o));
            const esearch = {};
            if (normalizedOptions.includes('COUNT')) {
                esearch.count = arr.length;
            }
            if (normalizedOptions.includes('MIN') && arr.length) {
                esearch.min = arr[0]; // already sorted ascending by search.js
            }
            if (normalizedOptions.includes('MAX') && arr.length) {
                esearch.max = arr[arr.length - 1];
            }
            if (normalizedOptions.includes('ALL') && arr.length) {
                esearch.all = packMessageRange(arr);
            }
            // PARTIAL cannot be derived client-side — omit it.
            // When returnOptions contains only { partial: ... } items and the server
            // lacks ESEARCH, PARTIAL cannot be derived client-side. Return the raw
            // number[] so the caller has actionable data. Note: this is an edge case
            // — callers targeting no-ESEARCH servers should avoid requesting PARTIAL
            // without COUNT or ALL.
            if (Object.keys(esearch).length === 0) {
                return result;
            }
            return esearch;
        }

        return result;
    }

    /**
     * @typedef {Object} FetchQueryObject
     * @global
     * @property {Boolean} [uid] if `true` then include UID in the response
     * @property {Boolean} [flags] if `true` then include flags Set in the response. Also adds `flagColor` to the response if the message is flagged.
     * @property {Boolean} [bodyStructure] if `true` then include parsed BODYSTRUCTURE object in the response
     * @property {Boolean} [envelope] if `true` then include parsed ENVELOPE object in the response
     * @property {Boolean} [internalDate] if `true` then include internal date value in the response
     * @property {Boolean} [size] if `true` then include message size in the response
     * @property {boolean | Object} [source] if `true` then include full message in the response
     * @property {Number} [source.start] include full message in the response starting from *start* byte
     * @property {Number} [source.maxLength] include full message in the response, up to *maxLength* bytes
     * @property {Boolean} [threadId] if `true` then include thread ID in the response (only if server supports either `OBJECTID` or `X-GM-EXT-1` extensions)
     * @property {Boolean} [labels] if `true` then include GMail labels in the response (only if server supports `X-GM-EXT-1` extension)
     * @property {boolean | string[]} [headers] if `true` then includes full headers of the message in the response. If the value is an array of header keys then includes only headers listed in the array
     * @property {string[]} [bodyParts] An array of BODYPART identifiers to include in the response
     * @property {Boolean} [fast] IMAP macro equivalent to `flags`, `internalDate`, `size`
     * @property {Boolean} [all] IMAP macro equivalent to `flags`, `internalDate`, `size`, `envelope`
     * @property {Boolean} [full] IMAP macro equivalent to `flags`, `internalDate`, `size`, `envelope`, `bodyStructure`
     */

    /**
     * Parsed email address entry
     *
     * @typedef {Object} MessageAddressObject
     * @global
     * @property {String} [name] name of the address object (unicode)
     * @property {String} [address] email address
     */

    /**
     * Parsed IMAP ENVELOPE object
     *
     * @typedef {Object} MessageEnvelopeObject
     * @global
     * @property {Date} [date] header date
     * @property {String} [subject] message subject (unicode)
     * @property {String} [messageId] Message ID of the message
     * @property {String} [inReplyTo] Message ID from In-Reply-To header
     * @property {MessageAddressObject[]} [from] Array of addresses from the From: header
     * @property {MessageAddressObject[]} [sender] Array of addresses from the Sender: header
     * @property {MessageAddressObject[]} [replyTo] Array of addresses from the Reply-To: header
     * @property {MessageAddressObject[]} [to] Array of addresses from the To: header
     * @property {MessageAddressObject[]} [cc] Array of addresses from the Cc: header
     * @property {MessageAddressObject[]} [bcc] Array of addresses from the Bcc: header
     */

    /**
     * Parsed IMAP BODYSTRUCTURE object
     *
     * @typedef {Object} MessageStructureObject
     * @global
     * @property {String} part Body part number. This value can be used to later fetch the contents of this part of the message
     * @property {String} type Content-Type of this node
     * @property {Object} [parameters] Additional parameters for Content-Type, eg "charset"
     * @property {String} [id] Content-ID
     * @property {String} [encoding] Transfer encoding
     * @property {Number} [size] Expected size of the node
     * @property {MessageEnvelopeObject} [envelope] message envelope of embedded RFC822 message
     * @property {String} [disposition] Content disposition
     * @property {Object} [dispositionParameters] Additional parameters for Content-Disposition
     * @property {MessageStructureObject[]} childNodes An array of child nodes if this is a multipart node. Not present for normal nodes
     */

    /**
     * Fetched message data
     *
     * @typedef {Object} FetchMessageObject
     * @global
     * @property {Number} seq message sequence number. Always included in the response
     * @property {Number} uid message UID number. Always included in the response
     * @property {Buffer} [source] message source for the requested byte range
     * @property {BigInt} [modseq] message Modseq number. Always included if the server supports CONDSTORE extension
     * @property {String} [emailId] unique email ID. Always included if server supports `OBJECTID` or `X-GM-EXT-1` extensions
     * @property {String} [threadId] unique thread ID. Only present if server supports `OBJECTID` or `X-GM-EXT-1` extension
     * @property {Set<string>} [labels] a Set of labels. Only present if server supports `X-GM-EXT-1` extension
     * @property {Number} [size] message size
     * @property {Set<string>} [flags] a set of message flags
     * @property {String} [flagColor] flag color like "red", or "yellow". This value is derived from the `flags` Set and it uses the same color rules as Apple Mail
     * @property {MessageEnvelopeObject} [envelope] message envelope
     * @property {MessageStructureObject} [bodyStructure] message body structure
     * @property {Date} [internalDate] message internal date
     * @property {Map<string, Buffer>} [bodyParts] a Map of message body parts where key is requested part identifier and value is a Buffer
     * @property {Set<string>} [binaryParts] part identifiers from `bodyParts` that arrived via FETCH BINARY, i.e. with the content-transfer-encoding already decoded by the server
     * @property {Buffer} [headers] Requested header lines as Buffer
     */

    /**
     * Fetch messages from the currently opened mailbox
     *
     * @param {SequenceString | Number[] | SearchObject} range Range of messages to fetch
     * @param {FetchQueryObject} query Fetch query
     * @param {Object} [options]
     * @param {Boolean} [options.uid] If `true` then uses UID numbers instead of sequence numbers for `range`
     * @param {BigInt} [options.changedSince] If set then only messages with a higher modseq value are returned. Ignored if server does not support `CONDSTORE` extension.
     * @param {Boolean} [options.binary=false] If `true` then requests a binary response if the server supports this
     * @yields {Promise<FetchMessageObject>} Message data object
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
    async *fetch(range, query, options) {
        options = options || {};

        if (!this.mailbox) {
            // no mailbox selected, nothing to do
            return;
        }

        range = await this.resolveRange(range, options);
        if (!range) {
            return false;
        }

        // Push/pull coordination for the async generator pattern:
        // The FETCH command handler pushes results into rowQueue via onUntaggedFetch.
        // The generator consumer pulls via getNext(). The `push` callback bridges the
        // two: when the consumer is waiting and the queue is empty, `push` is set to
        // a function that wakes up the consumer when new data arrives.
        let finished = false;
        let aborted = false;
        let push = false;
        let rowQueue = [];

        let getNext = () =>
            new Promise((resolve, reject) => {
                let check = () => {
                    if (rowQueue.length) {
                        let entry = rowQueue.shift();
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
        this.run('FETCH', range, query, {
            uid: !!options.uid,
            binary: options.binary,
            changedSince: options.changedSince,
            onUntaggedFetch: (untagged, next) => {
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

        let lastRes = null;
        try {
            let res;
            while ((res = await getNext())) {
                lastRes = res;

                if (this.isClosed || !this.socket || this.socket.destroyed) {
                    let error = new Error('Connection closed');
                    error.code = 'EConnectionClosed';
                    throw error;
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
                let entry = rowQueue.shift();
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
     * @param {SequenceString | Number[] | SearchObject} range Range of messages to fetch
     * @param {FetchQueryObject} query Fetch query
     * @param {Object} [options]
     * @param {Boolean} [options.uid] If `true` then uses UID numbers instead of sequence numbers for `range`
     * @param {BigInt} [options.changedSince] If set then only messages with a higher modseq value are returned. Ignored if server does not support `CONDSTORE` extension.
     * @param {Boolean} [options.binary=false] If `true` then requests a binary response if the server supports this
     * @returns {Promise<FetchMessageObject[]>} Array of Message data object
     *
     * @example
     * let mailbox = await client.mailboxOpen('INBOX');
     * // fetch UID for all messages in a mailbox
     * const messages = await client.fetchAll('1:*', {uid: true});
     * for (let msg of messages){
     *     console.log(msg.uid);
     * }
     */
    async fetchAll(range, query, options) {
        const results = [];
        const generator = this.fetch(range, query, options);
        for await (const message of generator) {
            results.push(message);
        }
        return results;
    }

    /**
     * Fetch a single message from the currently opened mailbox
     *
     * @param {SequenceString} seq Single UID or sequence number of the message to fetch for
     * @param {FetchQueryObject} query Fetch query
     * @param {Object} [options]
     * @param {Boolean} [options.uid] If `true` then uses UID number instead of sequence number for `seq`
     * @param {Boolean} [options.binary=false] If `true` then requests a binary response if the server supports this
     * @returns {Promise<FetchMessageObject>} Message data object
     *
     * @example
     * let mailbox = await client.mailboxOpen('INBOX');
     * // fetch UID for the last email in the selected mailbox
     * let lastMsg = await client.fetchOne('*', {uid: true})
     * console.log(lastMsg.uid);
     */
    async fetchOne(seq, query, options) {
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
     * @typedef {Object} DownloadObject
     * @global
     * @property {Object} meta content metadata
     * @property {number} meta.expectedSize The fetch response size
     * @property {String} meta.contentType Content-Type of the streamed file. If part was not set then this value is "message/rfc822"
     * @property {String} [meta.charset] Charset of the body part. Text parts are automatically converted to UTF-8, attachments are kept as is
     * @property {String} [meta.disposition] Content-Disposition of the streamed file
     * @property {String} [meta.filename] Filename of the streamed body part
     * @property {ReadableStream} content Streamed content
     */

    /**
     * Download either full rfc822 formatted message or a specific bodystructure part as a Stream.
     * Bodystructure parts are decoded so the resulting stream is a binary file. Text content
     * is automatically converted to UTF-8 charset.
     *
     * @param {SequenceString} range UID or sequence number for the message to fetch
     * @param {String} [part] If not set then downloads entire rfc822 formatted message, otherwise downloads specific bodystructure part
     * @param {Object} [options]
     * @param {Boolean} [options.uid] If `true` then uses UID number instead of sequence number for `range`
     * @param {number} [options.maxBytes] If set then limits download size to specified bytes
     * @param {number} [options.chunkSize=65536] How large content parts to ask from the server
     * @returns {Promise<DownloadObject>} Download data object
     *
     * @example
     * let mailbox = await client.mailboxOpen('INBOX');
     * // download body part nr '1.2' from latest message
     * let {meta, content} = await client.download('*', '1.2');
     * content.pipe(fs.createWriteStream(meta.filename));
     */
    async download(range, part, options) {
        if (!this.mailbox) {
            // no mailbox selected, nothing to do
            return {};
        }

        options = Object.assign(
            {
                chunkSize: 64 * 1024,
                maxBytes: Infinity
            },
            options || {}
        );

        let hasMore = true;
        let processed = 0;

        let chunkSize = Number(options.chunkSize) || 64 * 1024;
        // Normalized once here so every bounded stage of the pipeline below agrees on the budget
        let maxBytes = normalizeByteLimit(options.maxBytes);

        let uid = false;

        if (part === '1') {
            // Special handling for part "1": in single-node emails (no childNodes),
            // the body is accessed via "TEXT" rather than "1", and headers via
            // "HEADER" instead of "1.MIME". Check bodyStructure to detect this.
            let response = await this.fetchOne(range, { uid: true, bodyStructure: true }, options);

            if (!response) {
                return { response: false, chunk: false };
            }

            if (!uid && response.uid) {
                uid = response.uid;
                // force UID from now on even if first range was a sequence number
                range = uid;
                options.uid = true;
            }

            if (!response.bodyStructure.childNodes) {
                // single text message
                part = 'TEXT';
            }
        }

        let getNextPart = async query => {
            query = query || {};

            let mimeKey;

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

            let response = await this.fetchOne(range, query, options);

            if (!response) {
                return { response: false, chunk: false };
            }

            if (!uid && response.uid) {
                uid = response.uid;
                // force UID from now on even if first range was a sequence number
                range = uid;
                options.uid = true;
            }

            let chunk = !part ? response.source : response.bodyParts && response.bodyParts.get(part);
            if (!chunk) {
                return {};
            }

            processed += chunk.length;
            hasMore = chunk.length >= chunkSize;

            let result = { chunk };
            if (query.size) {
                result.response = response;
            }

            if (query.bodyParts) {
                if (mimeKey === 'header') {
                    result.mime = response.headers;
                } else {
                    result.mime = response.bodyParts.get(mimeKey);
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
            return {};
        }

        let meta = {
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
                    meta.disposition = libmime.decodeWords(meta.disposition);
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

        let stream;
        let output;
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
        let clientEncoding = response.binaryParts && response.binaryParts.has(part) ? false : meta.encoding;
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
        let limiters = [];
        let isLimited = () => limiters.some(entry => entry.limited);

        // Appending a stage means forwarding the current tail's errors to it before piping, so a
        // failure anywhere reaches the stream the caller is reading
        let pipeStage = stage => {
            output.on('error', err => {
                stage.emit('error', err);
            });
            output = output.pipe(stage);
            return stage;
        };

        let isTextNode = ['text/html', 'text/plain', 'text/x-amp-html'].includes(meta.contentType) || (part === '1' && !meta.contentType);
        if ((!meta.disposition || meta.disposition === 'inline') && isTextNode) {
            // RFC 3676 format=flowed text: unwrap soft line breaks
            if (meta.flowed) {
                // FlowedDecoder buffers its whole input before emitting, and being third party it
                // carries no bound of its own, so bound what it can ever be handed. Unwrapping only
                // removes bytes, so capping its input at maxBytes cannot push the delivered output
                // above the cap either.
                limiters.push(pipeStage(new LimitedPassthrough({ maxBytes })));

                pipeStage(new FlowedDecoder({ delSp: meta.delSp }));
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

        let writeChunk = chunk => {
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
                        await new Promise((resolve, reject) => {
                            let resolved = false;

                            const finish = err => {
                                /* c8 ignore next */ // the first call removes all three listeners, so a later drain/error/close can't re-enter finish; this guard is belt-and-suspenders
                                if (resolved) return;
                                resolved = true;

                                // Remove all listeners
                                stream.removeAllListeners('drain');
                                stream.removeAllListeners('error');
                                stream.removeAllListeners('close');

                                /* c8 ignore next 2 */ // stream error during a backpressure drain wait is timing-dependent
                                if (err) {
                                    reject(err);
                                } else {
                                    resolve();
                                }
                            };

                            stream.once('drain', () => finish());
                            stream.once('error', err => finish(err));
                            stream.once('close', () => finish());
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
                });
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
            content: output
        };
    }

    /**
     * Fetch multiple attachments as Buffer values
     *
     * @param {SequenceString} range UID or sequence number for the message to fetch
     * @param {String[]} parts A list of bodystructure parts
     * @param {Object} [options]
     * @param {Boolean} [options.uid] If `true` then uses UID number instead of sequence number for `range`
     * @returns {Promise<Object>} Download data object
     *
     * @example
     * let mailbox = await client.mailboxOpen('INBOX');
     * // download body parts '2', and '3' from all messages in the selected mailbox
     * let response = await client.downloadMany('*', ['2', '3']);
     * process.stdout.write(response[2].content)
     * process.stdout.write(response[3].content)
     */
    async downloadMany(range, parts, options) {
        if (!this.mailbox) {
            // no mailbox selected, nothing to do
            return {};
        }

        options = Object.assign(
            {
                chunkSize: 64 * 1024,
                maxBytes: Infinity
            },
            options || {}
        );

        let query = { bodyParts: [] };

        for (let part of parts) {
            query.bodyParts.push(part + '.mime');
            query.bodyParts.push(part);
        }

        let response = await this.fetchOne(range, query, options);

        if (!response || !response.bodyParts) {
            return { response: false };
        }

        let data = {};

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
                let key = keyParts[0];
                if (!data[key]) {
                    data[key] = { content };
                } else {
                    data[key].content = content;
                }
            } else if (keyParts.length === 2) {
                // header
                let key = keyParts[0];
                if (!data[key]) {
                    data[key] = {};
                }
                if (!data[key].meta) {
                    data[key].meta = {};
                }

                let headers = new Headers(content);
                let contentType = libmime.parseHeaderValue(headers.getFirst('Content-Type'));
                let transferEncoding = libmime.parseHeaderValue(headers.getFirst('Content-Transfer-Encoding'));
                let disposition = libmime.parseHeaderValue(headers.getFirst('Content-Disposition'));

                if (contentType.value.toLowerCase().trim()) {
                    data[key].meta.contentType = contentType.value.toLowerCase().trim();
                }

                if (contentType.params.charset) {
                    data[key].meta.charset = contentType.params.charset.toLowerCase().trim();
                }

                if (transferEncoding.value) {
                    data[key].meta.encoding = transferEncoding.value
                        .replace(/\(.*\)/g, '')
                        .toLowerCase()
                        .trim();
                }

                if (disposition.value) {
                    /* c8 ignore next */ // a parsed disposition value is never all-whitespace, so the `false` fallback is unreachable
                    data[key].meta.disposition = disposition.value.toLowerCase().trim() || false;
                    try {
                        data[key].meta.disposition = libmime.decodeWords(data[key].meta.disposition);
                    } catch {
                        // failed to parse disposition, keep as is (most probably an unknown charset is used)
                    }
                }

                if (contentType.params.format && contentType.params.format.toLowerCase().trim() === 'flowed') {
                    data[key].meta.flowed = true;
                    if (contentType.params.delsp && contentType.params.delsp.toLowerCase().trim() === 'yes') {
                        data[key].meta.delSp = true;
                    }
                }

                let filename = disposition.params.filename || contentType.params.name || false;
                if (filename) {
                    try {
                        filename = libmime.decodeWords(filename);
                    } catch {
                        // failed to parse filename, keep as is (most probably an unknown charset is used)
                    }
                    data[key].meta.filename = filename;
                }
            }
        }

        for (let part of Object.keys(data)) {
            // `meta` is only built from the companion BODY[<part>.MIME] item. A server may
            // legally answer with fewer items than were requested, and one part arriving
            // without its MIME headers must not cost the caller the whole download.
            let meta = data[part].meta || {};
            data[part].meta = meta;

            // parts that arrived via FETCH BINARY (response.binaryParts) are already
            // decoded by the server - decoding again would corrupt the data
            let clientEncoding = response.binaryParts && response.binaryParts.has(part) ? false : meta.encoding;
            switch (clientEncoding) {
                case 'base64':
                    data[part].content = data[part].content ? libbase64.decode(data[part].content.toString()) : null;
                    break;
                case 'quoted-printable':
                    data[part].content = data[part].content ? libqp.decode(data[part].content.toString()) : null;
                    break;
                default:
                // keep as is, already a buffer
            }
        }

        return data;
    }

    async run(command, ...args) {
        command = command.toUpperCase();
        if (!this.commands.has(command)) {
            return false;
        }

        if (!this.socket || this.socket.destroyed) {
            throw this.createNoConnectionError();
        }

        clearTimeout(this.idleStartTimer);

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
            if (command !== 'IDLE') {
                // do not autostart IDLE, if IDLE itself was stopped
                this.autoidle();
            }
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
     * @param {String} command Command name, as registered in the command registry.
     * @param {...*} args Arguments forwarded to the command implementation.
     * @returns {Promise<*>} Whatever the command implementation returns, or `false` for an
     *   unknown command.
     */
    async runInternal(command, ...args) {
        command = command.toUpperCase();
        if (!this.commands.has(command)) {
            return false;
        }

        if (!this.socket || this.socket.destroyed) {
            throw this.createNoConnectionError();
        }

        let handler = this.commands.get(command);
        return await handler(this, ...args);
    }

    // Mailbox lock queue processor. Implements a mutex pattern: only one lock
    // is active at a time. When the active lock is released, the next queued
    // lock is processed. The `processingLock` flag prevents concurrent runs
    // of this method (which could happen via setImmediate re-entry from release()).
    async processLocks() {
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

                const lock = this.locks.shift();
                const { resolve, reject, path, options, lockId } = lock;

                // From here on the grant/reject path owns the outcome; the acquire
                // timer must not race with resolution.
                if (lock.acquireTimer) {
                    clearTimeout(lock.acquireTimer);
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
                            heldFor: Date.now() - lock.heldAt,
                            /* c8 ignore next */ // the held-lock-warning diagnostic with a description set is a timing-dependent log detail
                            ...(options.description && { description: options.description }),
                            cid: this.id
                        });
                    }, threshold);
                    unrefTimer(lock.heldWarnTimer);
                };

                // release() is captured per-lock. It must only clear this.currentLock
                // if the caller still owns it — otherwise a stale release (after a
                // disconnect replaced the lock, or a double-release from user code)
                // would clear the new holder's lock and allow concurrent access.
                const release = () => {
                    if (this.currentLock === lock) {
                        if (lock.heldWarnTimer) {
                            clearTimeout(lock.heldWarnTimer);
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
                    let error = new Error('Connection not available');
                    error.code = 'NoConnection';
                    reject(error);
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
                    if (err.responseStatus === 'NO') {
                        // SELECT failed with NO -- verify whether the mailbox exists
                        // at all by running LIST. This sets mailboxMissing on the error
                        // so the caller can distinguish "doesn't exist" from other failures.
                        try {
                            let folders = await this.run('LIST', '', path, { listOnly: true });
                            if (!folders || !folders.length) {
                                err.mailboxMissing = true;
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
                    reject(err);
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
     * until previous lock is released. This is suggested over {@link module:imapflow~ImapFlow#mailboxOpen|mailboxOpen()} as
     * `getMailboxLock()` gives you a weak transaction while `mailboxOpen()` has no guarantees whatsoever that another
     * mailbox is opened while you try to call multiple fetch or store commands.
     *
     * @param {string|array} path **Path for the mailbox** to open
     * @param {Object} [options] optional options
     * @param {Boolean} [options.readOnly=false] If `true` then opens mailbox in read-only mode. You can still try to perform write operations but these would probably fail.
     * @returns {Promise<MailboxLockObject>} Mailbox lock
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
    getMailboxLock(path, options) {
        options = options || {};

        path = normalizePath(this, path);

        let lockId = ++this.lockCounter;
        this.log.trace({
            msg: 'Requesting lock',
            path,
            lockId,
            ...(options.description && { description: options.description }),
            activeLock: this.currentLock
                ? {
                      lockId: this.currentLock.lockId,
                      ...(this.currentLock.options?.description && { description: this.currentLock.options?.description })
                  }
                : null
        });

        let lockPromise = new Promise((resolve, reject) => {
            let lockEntry = { resolve, reject, path, options, lockId };
            this.locks.push(lockEntry);

            // Opt-in acquire timeout: if the lock has not been granted within
            // acquireTimeout ms, remove it from the queue and reject. Only
            // affects queued (pending) locks — once granted, the timer is cleared.
            if (Number(options.acquireTimeout) > 0) {
                lockEntry.acquireTimer = setTimeout(() => {
                    lockEntry.acquireTimer = null;
                    const idx = this.locks.indexOf(lockEntry);
                    if (idx !== -1) {
                        this.locks.splice(idx, 1);
                        let err = new Error('Timed out waiting for mailbox lock');
                        err.code = 'LockTimeout';
                        err.lockId = lockEntry.lockId;
                        reject(err);
                    }
                }, Number(options.acquireTimeout));
            }

            this.processLocks().catch(err => reject(err));
        });

        // Prevent unhandled promise rejection if close() rejects this lock
        // synchronously. The rejection still propagates to the caller.
        lockPromise.catch(noop);

        return lockPromise;
    }

    getLogger() {
        let mainLogger =
            this.options.logger && typeof this.options.logger === 'object'
                ? this.options.logger
                : logger.child({
                      component: 'imap-connection',
                      cid: this.id
                  });

        let synteticLogger = {};
        let levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
        for (let level of levels) {
            synteticLogger[level] = (...args) => {
                // using {logger:false} disables logging
                if (this.options.logger !== false) {
                    if (typeof mainLogger[level] !== 'function') {
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
                        mainLogger[level](...args);
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
     * @returns {Object} Socket objects
     * @returns {Object} return.readSocket The read socket (inflated socket if compression is enabled, raw socket otherwise)
     * @returns {Object} return.writeSocket The write socket
     * @returns {Object} return.socket The raw underlying socket (same as readSocket/writeSocket when compression is disabled)
     */
    unbind() {
        this.socket.unpipe(this.streamer);
        if (this._inflate) {
            this._inflate.unpipe(this.streamer);
        }

        // Detach all of ImapFlow's socket listeners — the raw socket plus, when
        // compression is active, the PassThrough writeSocket — so the connection
        // is fully released to the caller.
        this.clearSocketHandlers();

        const readSocket = this._inflate || this.socket;
        const writeSocket = this.writeSocket || this.socket;

        // Defense-in-depth: when compression is active the raw socket is orphaned
        // (neither readSocket nor writeSocket) yet still live and still the target
        // of the deflate/writeSocket error forwarders. We just stripped our own
        // error listener, so any post-unbind error (e.g. an upstream ECONNRESET)
        // would become an unhandled 'error' that crashes the host process. Attach
        // a benign listener so the orphaned socket can never throw after handoff.
        // Non-compression path: socket === readSocket === writeSocket and the
        // caller owns it directly, so leave it untouched (no behavior change).
        if (this.socket !== readSocket && this.socket !== writeSocket) {
            this.socket.on('error', err => {
                this.log.debug({ msg: 'Suppressed error on unbound socket', err, cid: this.id });
            });
        }

        return {
            readSocket,
            writeSocket,
            socket: this.socket
        };
    }
}

/**
 * Connection close event. **NB!** ImapFlow does not handle reconnects automatically.
 * So whenever a 'close' event occurs you must create a new connection yourself.
 *
 * @event module:imapflow~ImapFlow#close
 */

/**
 * Error event. In most cases getting an error event also means that connection is closed
 * and pending operations should return with a failure.
 *
 * @event module:imapflow~ImapFlow#error
 * @type {Error}
 * @example
 * client.on('error', err=>{
 *     console.log(`Error occurred: ${err.message}`);
 * });
 */

/**
 * Message count in currently opened mailbox changed
 *
 * @event module:imapflow~ImapFlow#exists
 * @type {Object}
 * @property {String} path mailbox path this event applies to
 * @property {Number} count updated count of messages
 * @property {Number} prevCount message count before this update
 * @example
 * client.on('exists', data=>{
 *     console.log(`Message count in "${data.path}" is ${data.count}`);
 * });
 */

/**
 * Deleted message sequence number in currently opened mailbox. One event is fired for every deleted email.
 *
 * @event module:imapflow~ImapFlow#expunge
 * @type {Object}
 * @property {String} path mailbox path this event applies to
 * @property {Number} seq sequence number of deleted message
 * @property {Boolean} vanished `true` if message was expunged via VANISHED response
 * @property {Number} [uid] UID of expunged message (when `vanished` is `true`)
 * @property {Boolean} [earlier] `true` for VANISHED EARLIER responses
 * @example
 * client.on('expunge', data=>{
 *     console.log(`Message #${data.seq} was deleted from "${data.path}"`);
 * });
 */

/**
 * Flags were updated for a message. Not all servers fire this event.
 *
 * @event module:imapflow~ImapFlow#flags
 * @type {Object}
 * @property {String} path mailbox path this event applies to
 * @property {Number} seq sequence number of updated message
 * @property {Number} [uid] UID number of updated message (if server provided this value)
 * @property {BigInt} [modseq] Updated modseq number for the mailbox (if server provided this value)
 * @property {Set<string>} flags A set of all flags for the updated message
 * @property {String} [flagColor] flag color like "red", or "yellow". Derived from the `flags` Set using Apple Mail color rules
 * @example
 * client.on('flags', data=>{
 *     console.log(`Flag set for #${data.seq} is now "${Array.from(data.flags).join(', ')}"`);
 * });
 */

/**
 * Mailbox was opened
 *
 * @event module:imapflow~ImapFlow#mailboxOpen
 * @type {MailboxObject}
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
 * @event module:imapflow~ImapFlow#mailboxClose
 * @type {MailboxObject}
 * @example
 * client.on('mailboxClose', mailbox => {
 *     console.log(`Mailbox ${mailbox.path} was closed`);
 * });
 */

/**
 * Log event if `emitLogs=true`
 *
 * @event module:imapflow~ImapFlow#log
 * @type {Object}
 * @example
 * client.on('log', entry => {
 *     console.log(`${entry.cid} ${entry.msg}`);
 * });
 */

module.exports.ImapFlow = ImapFlow;
