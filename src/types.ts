// Public data shapes of the ImapFlow API. Every optional property is declared with an
// explicit `| undefined` so that a consumer compiling with exactOptionalPropertyTypes
// can still pass a value that may be undefined.

import type { ConnectionOptions, CipherNameAndProtocol } from 'node:tls';
import type { Readable } from 'node:stream';

/**
 * Logger interface. Any object with `debug`, `info`, `warn` and `error` methods can be used,
 * for example a pino or bunyan instance. `trace` and `fatal` are used when present.
 */
export interface Logger {
    trace?: ((obj: any) => void) | undefined;
    debug(obj: any): void;
    info(obj: any): void;
    warn(obj: any): void;
    error(obj: any): void;
    fatal?: ((obj: any) => void) | undefined;
}

/**
 * Authentication options
 */
export interface AuthOptions {
    /** Username */
    user: string;
    /** Password for regular authentication (if using OAuth2 then use `accessToken` instead) */
    pass?: string | undefined;
    /** OAuth2 access token, if using OAuth2 authentication */
    accessToken?: string | undefined;
    /** Optional login method override. Set to 'LOGIN', 'AUTH=LOGIN' or 'AUTH=PLAIN' to use specific method */
    loginMethod?: string | undefined;
    /** Authorization identity for SASL PLAIN (used for admin impersonation/delegation). When set, authenticates as `user` but authorizes as `authzid` */
    authzid?: string | undefined;
}

export interface ImapFlowOptions {
    /** Hostname of the IMAP server */
    host?: string | undefined;
    /** Port number for the IMAP server */
    port?: number | undefined;
    /** If true, the connection will use TLS. If false, then TLS is used only if the server supports STARTTLS extension */
    secure?: boolean | undefined;
    /** Servername for SNI (or when host is set to an IP address) */
    servername?: string | undefined;
    /** If true, do not use COMPRESS=DEFLATE extension even if server supports it */
    disableCompression?: boolean | undefined;
    /** Authentication options */
    auth?: AuthOptions | undefined;
    /** Client identification info sent to the server if server supports ID extension */
    clientInfo?: IdInfoObject | undefined;
    /** If true, then do not start IDLE when connection is established */
    disableAutoIdle?: boolean | undefined;
    /**
     * How long (in ms) the connection has to be inactive before IDLE is started automatically.
     * Keep it above the pause your own code usually leaves between two commands, otherwise every
     * command is followed by an IDLE that the next command has to break, costing two extra
     * round-trips per command. To turn auto-IDLE off use `disableAutoIdle` rather than a very
     * large delay: the value is capped below `socketTimeout`, because auto-IDLE has to start
     * before the inactivity watchdog fires. On servers without IDLE support this controls when
     * the polling fallback starts, not how often it polls - the poll interval is `maxIdleTime`,
     * capped at 2 minutes. Default: 15000 ms.
     */
    autoIdleDelay?: number | string | undefined;
    /** Additional TLS options (see Node.js TLS documentation) */
    tls?: ConnectionOptions | undefined;
    /** Custom logger instance. Set to false to disable logging */
    logger?: Logger | false | undefined;
    /**
     * If true, log data read and written to socket encoded in base64. Client frames that carry
     * credentials are replaced with a fixed placeholder and marked with `hidden: true`.
     */
    logRaw?: boolean | undefined;
    /** If true, emit 'log' events */
    emitLogs?: boolean | undefined;
    /** If true, then logs out automatically after successful authentication */
    verifyOnly?: boolean | undefined;
    /** If true and verifyOnly is set, lists mailboxes */
    includeMailboxes?: boolean | undefined;
    /**
     * Proxy URL. Supports HTTP CONNECT (http:, https:) and SOCKS (socks:, socks4:, socks4a:,
     * socks5:) proxies. IPv6 proxy endpoints are given in URL form, e.g. `socks5://[2001:db8::1]:1080`.
     *
     * DNS behaviour depends on the proxy protocol:
     *   - `http:`/`https:` - the destination hostname is sent to the proxy unresolved
     *   - `socks4:` - destination hostnames are resolved locally to IPv4 (SOCKS4 has no IPv6
     *     destination address type; IPv6 destinations are rejected)
     *   - `socks4a:` - destination hostnames are sent to the proxy for remote DNS (IPv6
     *     destinations are rejected)
     *   - `socks:`/`socks5:` - destination hostnames are sent to the proxy for remote DNS, IPv4
     *     and IPv6 literals are passed through
     *
     * The proxy endpoint itself is never resolved by ImapFlow; a hostname endpoint is handed to
     * Node as-is. Proxy DNS and negotiation run inside `connectionTimeout`.
     */
    proxy?: string | undefined;
    /** If true, then use QRESYNC instead of CONDSTORE. EXPUNGE notifications will include UID instead of sequence number */
    qresync?: boolean | undefined;
    /** If set, then breaks and restarts IDLE every maxIdleTime ms */
    maxIdleTime?: number | undefined;
    /** What command to run if IDLE is not supported. Defaults to 'NOOP' */
    missingIdleCommand?: 'NOOP' | 'SELECT' | 'STATUS' | undefined;
    /** If true, ignores BINARY extension when making FETCH and APPEND calls */
    disableBinary?: boolean | undefined;
    /** If true, do not enable supported extensions */
    disableAutoEnable?: boolean | undefined;
    /** If true, do not enable IMAP4rev2 mode even if the server supports it */
    disableIMAP4rev2?: boolean | undefined;
    /**
     * How long to wait for a usable transport, covering DNS resolution, proxy negotiation and the
     * TCP/TLS handshake as a single budget. Defaults to 90 seconds. An expiry in any of those
     * phases rejects with error code `CONNECT_TIMEOUT`.
     */
    connectionTimeout?: number | undefined;
    /** How long to wait for the greeting. Defaults to 16 seconds */
    greetingTimeout?: number | undefined;
    /** How long to wait for socket inactivity before timing out the connection. Defaults to 5 minutes */
    socketTimeout?: number | undefined;
    /**
     * Maximum allowed length in bytes of a single response line (a response without a literal).
     * Guards against a malicious or broken server that never sends a line terminator. Defaults to
     * 1GB. The line terminator counts towards the limit and a line exactly at the limit is
     * accepted. `Infinity` disables the limit. An in-progress line is additionally bounded by
     * whatever is left of `maxResponseSize`, so lowering that also bounds line buffering.
     * Exceeding it is terminal: the connection fails with error code `LineTooLarge` and
     * no further input is parsed.
     */
    maxLineLength?: number | undefined;
    /**
     * Maximum allowed size in bytes of a single IMAP literal block. Bounds peak memory allocation
     * against a malicious or broken server announcing an oversized literal. Defaults to 1GB. A
     * literal exactly at the limit is accepted, provided `maxResponseSize` leaves room for the
     * marker line as the defaults do. `Infinity` disables the limit. Exceeding it is terminal: the connection fails
     * with error code `LiteralTooLarge`, and neither the marker line nor any byte of the rejected
     * literal is interpreted as protocol.
     */
    maxLiteralSize?: number | undefined;
    /**
     * Maximum allowed total size in bytes of a single assembled IMAP response (every line
     * segment and literal of one response combined). Bounds peak memory allocation against
     * a malicious or broken server that spreads response data across an unbounded number of
     * tokens, which the per-line and per-literal caps alone cannot stop. Defaults to 2GB,
     * which is above the default literal cap on purpose: the total also carries the literal
     * marker line and the rest of the response framing, so a value equal to `maxLiteralSize`
     * would make a literal of exactly the maximum permitted size impossible to receive. Set
     * this above `maxLiteralSize` when configuring both. `Infinity` disables the limit.
     * Exceeding it is terminal: the connection fails with error code `ResponseTooLarge` and
     * no further input is parsed.
     */
    maxResponseSize?: number | undefined;
    /**
     * Threshold in milliseconds for warning that a mailbox lock has been held
     * for a long time (diagnostic for forgotten release() calls). Defaults to
     * 30 minutes. Set to 0 or false to disable.
     */
    maxLockHoldTime?: number | false | undefined;
    /** If true, uses TLS. If false, uses cleartext. If not set, upgrades to TLS if available */
    doSTARTTLS?: boolean | undefined;
    /** Custom instance ID string for logs */
    id?: string | undefined;
    /** Optional expunge event handler function */
    expungeHandler?: ((event: ExpungeEvent) => Promise<void> | void) | undefined;
}

export interface MailboxObject {
    /** Mailbox path */
    path: string;
    /** Mailbox path delimiter, usually "." or "/" */
    delimiter: string;
    /** List of flags for this mailbox */
    flags: Set<string>;
    /** One of special-use flags (if applicable): "\All", "\Archive", "\Drafts", "\Flagged", "\Junk", "\Sent", "\Trash". Additionally INBOX has non-standard "\Inbox" flag set */
    specialUse?: string | undefined;
    /** True if mailbox was found from the output of LIST command */
    listed?: boolean | undefined;
    /** True if the mailbox is subscribed - reported by LSUB or by LIST RETURN (SUBSCRIBED) on LIST-EXTENDED/IMAP4rev2 servers. Servers that answer neither report no subscription state at all, and every mailbox is then assumed to be subscribed */
    subscribed?: boolean | undefined;
    /** A Set of flags available to use in this mailbox. If it is not set or includes special flag "\*" then any flag can be used */
    permanentFlags?: Set<string> | undefined;
    /** Unique mailbox ID if server has OBJECTID extension enabled */
    mailboxId?: string | undefined;
    /** Latest known modseq value if server has CONDSTORE or XYMHIGHESTMODSEQ enabled */
    highestModseq?: bigint | undefined;
    /** If true then the server doesn't support the persistent storage of mod-sequences for the mailbox */
    noModseq?: boolean | undefined;
    /** Mailbox UIDVALIDITY value */
    uidValidity: bigint;
    /** Next predicted UID */
    uidNext: number;
    /** Messages in this folder */
    exists: number;
    /** Sequence number of the first unseen message, if the server reported [UNSEEN] on SELECT. Not a count of unseen messages - use mailboxStatus() with {unseen: true} for that */
    unseen?: number | undefined;
    /** Largest message size in octets the server accepts for APPEND into this mailbox, if it reported [APPENDLIMIT] (RFC 7889) */
    appendlimit?: number | undefined;
    /** Read-only state */
    readOnly?: boolean | undefined;
}

export interface MailboxLockObject {
    /** Mailbox path */
    path: string;
    /** Release current lock */
    release(): void;
}

export interface IdInfoObject {
    /** Name of the program */
    name?: string | false | undefined;
    /** Version number of the program */
    version?: string | false | undefined;
    /** Name of the operating system */
    os?: string | false | undefined;
    /** Vendor of the client/server */
    vendor?: string | false | undefined;
    /** URL to contact for support */
    'support-url'?: string | false | undefined;
    /** Date program was released */
    date?: Date | string | false | undefined;
    [key: string]: any;
}

export interface QuotaResponse {
    /** Mailbox path this quota applies to */
    path: string;
    /** Storage quota if provided by server */
    storage?:
        | {
              /** Used storage in bytes */
              used: number;
              /** Total storage available */
              limit: number;
          }
        | undefined;
    /** Message count quota if provided by server */
    messages?:
        | {
              /** Stored messages */
              used: number;
              /** Maximum messages allowed */
              limit: number;
          }
        | undefined;
    [resource: string]: any;
}

/**
 * Status data items to request with `status()` or the `statusQuery` listing option
 */
export interface StatusQuery {
    /** If true request count of messages */
    messages?: boolean | undefined;
    /** If true request count of messages with \Recent tag */
    recent?: boolean | undefined;
    /** If true request predicted next UID */
    uidNext?: boolean | undefined;
    /** If true request mailbox UIDVALIDITY value */
    uidValidity?: boolean | undefined;
    /** If true request count of unseen messages */
    unseen?: boolean | undefined;
    /** If true request last known modseq value */
    highestModseq?: boolean | undefined;
    /** If true request total mailbox size in octets (requires STATUS=SIZE or IMAP4rev2) */
    size?: boolean | undefined;
    /** If true request count of messages with \Deleted flag (requires IMAP4rev2) */
    deleted?: boolean | undefined;
}

/**
 * Explicit special-use folder paths, overriding what the server reports
 */
export interface SpecialUseHints {
    /** Path to "Sent Mail" folder */
    sent?: string | undefined;
    /** Path to "Trash" folder */
    trash?: string | undefined;
    /** Path to "Junk Mail" folder */
    junk?: string | undefined;
    /** Path to "Drafts" folder */
    drafts?: string | undefined;
    /** Path to "Archive" folder */
    archive?: string | undefined;
}

export interface ListResponse {
    /** Mailbox path (unicode string) */
    path: string;
    /** Mailbox path as listed in the LIST/LSUB response */
    pathAsListed: string;
    /** Mailbox name (last part of path after delimiter) */
    name: string;
    /** Mailbox path delimiter, usually "." or "/" */
    delimiter: string;
    /** An array of parent folder names. All names are in unicode */
    parent: string[];
    /** Same as parent, but as a complete string path (unicode string) */
    parentPath: string;
    /** A set of flags for this mailbox */
    flags: Set<string>;
    /** One of special-use flags (if applicable) */
    specialUse?: string | undefined;
    /** How specialUse was determined: "user" (from specialUseHints), "extension" (SPECIAL-USE or XLIST flag reported by the server) or "name" (matched against known localized folder names) */
    specialUseSource?: 'user' | 'extension' | 'name' | undefined;
    /** True if mailbox was found from the output of LIST command */
    listed: boolean;
    /** True if the mailbox is subscribed - reported by LSUB or by LIST RETURN (SUBSCRIBED) on LIST-EXTENDED/IMAP4rev2 servers. Servers that answer neither report no subscription state at all, and every mailbox is then assumed to be subscribed */
    subscribed: boolean;
    /** If statusQuery was used, then this value includes the status response */
    status?: StatusObject | undefined;
}

export interface ListOptions {
    /** Request status items for every listed entry */
    statusQuery?: StatusQuery | undefined;
    /** Set specific paths as special use folders */
    specialUseHints?: SpecialUseHints | undefined;
    /** If true then only runs LIST, without LSUB or subscription lookups */
    listOnly?: boolean | undefined;
}

export interface ListTreeResponse {
    /** If true then this is root node without any additional properties besides folders */
    root?: boolean | undefined;
    /** Mailbox path */
    path?: string | undefined;
    /** Mailbox name (last part of path after delimiter) */
    name?: string | undefined;
    /** Mailbox path delimiter, usually "." or "/" */
    delimiter?: string | undefined;
    /** List of flags for this mailbox */
    flags?: Set<string> | undefined;
    /** One of special-use flags (if applicable) */
    specialUse?: string | undefined;
    /** True if mailbox was found from the output of LIST command */
    listed?: boolean | undefined;
    /** True if the mailbox is subscribed - reported by LSUB or by LIST RETURN (SUBSCRIBED) on LIST-EXTENDED/IMAP4rev2 servers. Servers that answer neither report no subscription state at all, and every mailbox is then assumed to be subscribed */
    subscribed?: boolean | undefined;
    /** If true then this mailbox can not be selected in the UI */
    disabled?: boolean | undefined;
    /** An array of subfolders */
    folders?: ListTreeResponse[] | undefined;
    /** Status response */
    status?: StatusObject | undefined;
}

export interface MailboxCreateResponse {
    /** Full mailbox path */
    path: string;
    /** Unique mailbox ID if server supports OBJECTID extension */
    mailboxId?: string | undefined;
    /** If true then mailbox was created otherwise it already existed */
    created: boolean;
}

export interface MailboxRenameResponse {
    /** Full mailbox path that was renamed */
    path: string;
    /** New full mailbox path */
    newPath: string;
}

export interface MailboxDeleteResponse {
    /** Full mailbox path that was deleted */
    path: string;
}

export interface StatusObject {
    /** Full mailbox path that was checked */
    path: string;
    /** Count of messages */
    messages?: number | undefined;
    /** Count of messages with \Recent tag */
    recent?: number | undefined;
    /** Predicted next UID */
    uidNext?: number | undefined;
    /** Mailbox UIDVALIDITY value */
    uidValidity?: bigint | undefined;
    /** Count of unseen messages */
    unseen?: number | undefined;
    /** Last known modseq value (if CONDSTORE extension is enabled) */
    highestModseq?: bigint | undefined;
    /** Total size of the mailbox in octets (only if requested and the server supports STATUS=SIZE or IMAP4rev2) */
    size?: number | undefined;
    /** Count of messages with \Deleted flag (only if requested and IMAP4rev2 is active) */
    deleted?: number | undefined;
}

/**
 * Sequence range string. Separate different values with commas, number ranges with colons and use "*" as the placeholder for the newest message in mailbox
 */
export type SequenceString = string | number | bigint;

export interface SearchObject {
    /** Message ordering sequence range */
    seq?: SequenceString | undefined;
    /** Messages with (value is true) or without (value is false) \Answered flag */
    answered?: boolean | undefined;
    /** Messages with (value is true) or without (value is false) \Deleted flag */
    deleted?: boolean | undefined;
    /** Messages with (value is true) or without (value is false) \Draft flag */
    draft?: boolean | undefined;
    /** Messages with (value is true) or without (value is false) \Flagged flag */
    flagged?: boolean | undefined;
    /** Messages with (value is true) or without (value is false) \Seen flag */
    seen?: boolean | undefined;
    /** If true matches all messages */
    all?: boolean | undefined;
    /** If true matches messages that have the \Recent flag set but not the \Seen flag */
    new?: boolean | undefined;
    /** If true matches messages that do not have the \Recent flag set */
    old?: boolean | undefined;
    /** If true matches messages that have the \Recent flag set */
    recent?: boolean | undefined;
    /** Matches From: address field */
    from?: string | undefined;
    /** Matches To: address field */
    to?: string | undefined;
    /** Matches Cc: address field */
    cc?: string | undefined;
    /** Matches Bcc: address field */
    bcc?: string | undefined;
    /** Matches message body */
    body?: string | undefined;
    /** Matches message subject */
    subject?: string | undefined;
    /** Matches any text in headers and body */
    text?: string | undefined;
    /** Matches messages larger than value */
    larger?: number | undefined;
    /** Matches messages smaller than value */
    smaller?: number | undefined;
    /** UID sequence range */
    uid?: SequenceString | undefined;
    /** Matches messages with modseq higher than value */
    modseq?: bigint | number | undefined;
    /** Unique email ID. Only used if server supports OBJECTID or X-GM-EXT-1 extensions */
    emailId?: string | undefined;
    /** Unique thread ID. Only used if server supports OBJECTID or X-GM-EXT-1 extensions */
    threadId?: string | undefined;
    /** Matches messages received before date */
    before?: Date | string | undefined;
    /** Matches messages received on date (ignores time) */
    on?: Date | string | undefined;
    /** Matches messages received after date */
    since?: Date | string | undefined;
    /** Matches messages sent before date */
    sentBefore?: Date | string | undefined;
    /** Matches messages sent on date (ignores time) */
    sentOn?: Date | string | undefined;
    /** Matches messages sent after date */
    sentSince?: Date | string | undefined;
    /** Matches messages that have the custom flag set */
    keyword?: string | undefined;
    /** Matches messages that do not have the custom flag set */
    unKeyword?: string | undefined;
    /** Matches messages with header key set if value is true or messages where header partially matches a string value */
    header?: { [key: string]: boolean | string } | undefined;
    /** A SearchObject object. It must not match */
    not?: SearchObject | undefined;
    /** An array of 2 or more SearchObject objects. At least one of these must match */
    or?: SearchObject[] | undefined;
    /** Gmail raw search query (only for Gmail) */
    gmraw?: string | undefined;
    /** Gmail raw search query (alias for gmraw) */
    gmailraw?: string | undefined;
    /** Gmail label filter (only for Gmail). Compiles to an X-GM-RAW "label:"/"-label:" query. "has" matches messages carrying all listed labels, "not" excludes messages carrying any listed label */
    labels?: { has?: string[] | undefined; not?: string[] | undefined } | undefined;
}

/**
 * A message range: a sequence string, a list of sequence numbers or a search query
 */
export type MessageRange = SequenceString | number[] | SearchObject;

export interface FetchBodyPartQuery {
    /** Body part identifier, for example "1.2" or "HEADER" */
    key: string;
    /** Start offset in bytes */
    start?: number | undefined;
    /** Maximum number of bytes to fetch */
    maxLength?: number | undefined;
}

export interface FetchQueryObject {
    /** If true then include UID in the response */
    uid?: boolean | undefined;
    /** If true then include flags Set in the response */
    flags?: boolean | undefined;
    /** If true then include parsed BODYSTRUCTURE object in the response */
    bodyStructure?: boolean | undefined;
    /** If true then include parsed ENVELOPE object in the response */
    envelope?: boolean | undefined;
    /** If true then include internal date value in the response */
    internalDate?: boolean | undefined;
    /** If true then include message size in the response */
    size?: boolean | undefined;
    /** If true then include full message in the response */
    source?:
        | boolean
        | {
              /** Include full message in the response starting from start byte */
              start?: number | undefined;
              /** Include full message in the response, up to maxLength bytes */
              maxLength?: number | undefined;
          }
        | undefined;
    /** If true then include thread ID in the response (only if server supports either OBJECTID or X-GM-EXT-1 extensions) */
    threadId?: boolean | undefined;
    /** If true then include GMail labels in the response (only if server supports X-GM-EXT-1 extension) */
    labels?: boolean | undefined;
    /** If true then includes full headers of the message in the response. If the value is an array of header keys then includes only headers listed in the array */
    headers?: boolean | string[] | undefined;
    /** An array of BODYPART identifiers to include in the response */
    bodyParts?: Array<string | FetchBodyPartQuery> | undefined;
    /** Fast macro equivalent to flags, internalDate, size */
    fast?: boolean | undefined;
    /** All macro equivalent to flags, internalDate, size, envelope */
    all?: boolean | undefined;
    /** Full macro equivalent to flags, internalDate, size, envelope, bodyStructure */
    full?: boolean | undefined;
}

export interface MessageAddressObject {
    /** Name of the address object (unicode) */
    name?: string | undefined;
    /** Email address */
    address?: string | undefined;
}

export interface MessageEnvelopeObject {
    /** Header date */
    date?: Date | string | undefined;
    /** Message subject (unicode) */
    subject?: string | undefined;
    /** Message ID of the message */
    messageId?: string | undefined;
    /** Message ID from In-Reply-To header */
    inReplyTo?: string | undefined;
    /** Array of addresses from the From: header */
    from?: MessageAddressObject[] | undefined;
    /** Array of addresses from the Sender: header */
    sender?: MessageAddressObject[] | undefined;
    /** Array of addresses from the Reply-To: header */
    replyTo?: MessageAddressObject[] | undefined;
    /** Array of addresses from the To: header */
    to?: MessageAddressObject[] | undefined;
    /** Array of addresses from the Cc: header */
    cc?: MessageAddressObject[] | undefined;
    /** Array of addresses from the Bcc: header */
    bcc?: MessageAddressObject[] | undefined;
}

export interface MessageStructureObject {
    /** Body part number. This value can be used to later fetch the contents of this part of the message */
    part?: string | undefined;
    /** Content-Type of this node */
    type: string;
    /** Additional parameters for Content-Type, eg "charset" */
    parameters?: { [key: string]: string } | undefined;
    /** Content-ID */
    id?: string | undefined;
    /** Transfer encoding */
    encoding?: string | undefined;
    /** Expected size of the node */
    size?: number | undefined;
    /** Message envelope of embedded RFC822 message */
    envelope?: MessageEnvelopeObject | undefined;
    /** Content disposition */
    disposition?: string | undefined;
    /** Additional parameters for Content-Disposition */
    dispositionParameters?: { [key: string]: string } | undefined;
    /** An array of child nodes if this is a multipart node */
    childNodes?: MessageStructureObject[] | undefined;
    /** MD5 hash */
    md5?: string | undefined;
    /** Language */
    language?: string[] | undefined;
    /** Location */
    location?: string | undefined;
    /** Description */
    description?: string | undefined;
    /** Line count */
    lineCount?: number | undefined;
}

export interface FetchMessageObject {
    /** Message sequence number. Always included in the response */
    seq: number;
    /** Message UID number. Always included in the response */
    uid: number;
    /** Message source for the requested byte range */
    source?: Buffer | undefined;
    /** Message Modseq number. Always included if the server supports CONDSTORE extension */
    modseq?: bigint | undefined;
    /** Unique email ID. Always included if server supports OBJECTID or X-GM-EXT-1 extensions */
    emailId?: string | undefined;
    /** Unique thread ID. Only present if server supports OBJECTID or X-GM-EXT-1 extension */
    threadId?: string | undefined;
    /** A Set of labels. Only present if server supports X-GM-EXT-1 extension */
    labels?: Set<string> | undefined;
    /** Message size */
    size?: number | undefined;
    /** A set of message flags */
    flags?: Set<string> | undefined;
    /** Flag color like "red", or "yellow". This value is derived from the flags Set */
    flagColor?: string | undefined;
    /** Message envelope */
    envelope?: MessageEnvelopeObject | undefined;
    /** Message body structure */
    bodyStructure?: MessageStructureObject | undefined;
    /** Message internal date */
    internalDate?: Date | string | undefined;
    /** A Map of message body parts where key is requested part identifier and value is a Buffer */
    bodyParts?: Map<string, Buffer> | undefined;
    /** Part identifiers from bodyParts that arrived via FETCH BINARY, i.e. with the content-transfer-encoding already decoded by the server */
    binaryParts?: Set<string> | undefined;
    /** Requested header lines as Buffer */
    headers?: Buffer | undefined;
    /** Account unique ID for this email */
    id?: string | undefined;
}

export interface DownloadMeta {
    /** The fetch response size */
    expectedSize?: number | undefined;
    /** Content-Type of the streamed file */
    contentType?: string | undefined;
    /** Charset of the body part */
    charset?: string | undefined;
    /** Content-Disposition of the streamed file */
    disposition?: string | false | undefined;
    /** Filename of the streamed body part */
    filename?: string | undefined;
    /** Transfer encoding */
    encoding?: string | undefined;
    /** If content uses flowed formatting */
    flowed?: boolean | undefined;
    /** If flowed text uses delSp */
    delSp?: boolean | undefined;
}

export interface DownloadObject {
    /** Content metadata */
    meta: DownloadMeta;
    /** Streamed content */
    content: Readable;
}

export interface DownloadOptions {
    /** If true then uses UID number instead of sequence number for `range` */
    uid?: boolean | undefined;
    /** If set then limits download size to specified bytes */
    maxBytes?: number | undefined;
    /** How large content parts to ask from the server. Defaults to 65536 */
    chunkSize?: number | undefined;
}

/** Options for downloadMany(), the same shape as the download() options */
export type DownloadManyOptions = DownloadOptions;

export interface DownloadManyPart {
    meta: DownloadMeta;
    content?: Buffer | null | undefined;
}

export type DownloadManyResult = { [part: string]: DownloadManyPart };

export interface AppendResponseObject {
    /** Full mailbox path where the message was uploaded to */
    destination: string;
    /** Mailbox UIDVALIDITY if server has UIDPLUS extension enabled */
    uidValidity?: bigint | undefined;
    /** UID of the uploaded message if server has UIDPLUS extension enabled */
    uid?: number | undefined;
    /** Sequence number of the uploaded message if path is currently selected mailbox */
    seq?: number | undefined;
}

export interface CopyResponseObject {
    /** Path of source mailbox */
    path: string;
    /** Path of destination mailbox */
    destination: string;
    /** Destination mailbox UIDVALIDITY if server has UIDPLUS extension enabled */
    uidValidity?: bigint | undefined;
    /** Map of UID values where key is UID in source mailbox and value is the UID for the same message in destination mailbox */
    uidMap?: Map<number, number> | undefined;
}

export interface FetchOptions {
    /** If true then uses UID numbers instead of sequence numbers */
    uid?: boolean | undefined;
    /** If set then only messages with a higher modseq value are returned */
    changedSince?: bigint | number | undefined;
    /** If true then requests a binary response if the server supports this */
    binary?: boolean | undefined;
}

export interface StoreOptions {
    /** If true then uses UID numbers instead of sequence numbers */
    uid?: boolean | undefined;
    /** If set then only messages with a lower or equal modseq value are updated */
    unchangedSince?: bigint | number | undefined;
    /** If true then update Gmail labels instead of message flags */
    useLabels?: boolean | undefined;
    /** If true then does not emit 'flags' event */
    silent?: boolean | undefined;
}

export interface MailboxOpenOptions {
    /** If true then opens mailbox in read-only mode */
    readOnly?: boolean | undefined;
    /** Optional description for mailbox lock tracking */
    description?: string | undefined;
}

export interface MailboxLockOptions extends MailboxOpenOptions {
    /**
     * Optional timeout in milliseconds to wait for the lock to be granted.
     * If the lock cannot be acquired within this time, the promise rejects
     * with an error whose `code` is `'LockTimeout'`. Defaults to no timeout.
     */
    acquireTimeout?: number | undefined;
    /**
     * Per-call override for the threshold after which a held lock triggers
     * a warning log entry. Overrides the ImapFlow constructor option of the
     * same name. Set to 0 or false to disable for this lock only.
     */
    maxLockHoldTime?: number | false | undefined;
}

/** Options for messageCopy(), messageMove() and messageDelete() */
export interface MessageRangeOptions {
    /** If true then uses UID numbers instead of sequence numbers */
    uid?: boolean | undefined;
}

/** A RETURN option for ESEARCH (RFC 4731) and PARTIAL (RFC 9394) searches */
export type SearchReturnOption = 'MIN' | 'MAX' | 'COUNT' | 'ALL' | 'min' | 'max' | 'count' | 'all' | { partial: string };

export interface SearchOptions {
    /** If true then returns UID numbers instead of sequence numbers */
    uid?: boolean | undefined;
    /** ESEARCH RETURN options. When set, the result is an ESearchResult object */
    returnOptions?: SearchReturnOption[] | undefined;
}

export interface ExpungeEvent {
    /** Mailbox path */
    path: string;
    /** Sequence number (if vanished is false) */
    seq?: number | undefined;
    /** UID number (if vanished is true or QRESYNC is enabled) */
    uid?: number | undefined;
    /** True if message was expunged using VANISHED response */
    vanished: boolean;
    /** True if VANISHED EARLIER response */
    earlier?: boolean | undefined;
}

export interface ExistsEvent {
    /** Mailbox path */
    path: string;
    /** Updated count of messages */
    count: number;
    /** Message count before this update */
    prevCount: number;
}

export interface FlagsEvent {
    /** Mailbox path */
    path: string;
    /** Sequence number of updated message */
    seq: number;
    /** UID number of updated message (if server provided this value) */
    uid?: number | undefined;
    /** Updated modseq number for the mailbox */
    modseq?: bigint | undefined;
    /** A set of all flags for the updated message */
    flags: Set<string>;
    /** Flag color if message is flagged */
    flagColor?: string | undefined;
}

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/**
 * The logger a connection uses internally: every level is always callable, whatever the
 * configured logger supports, and entries are mirrored as 'log' events when `emitLogs` is set
 */
export type InternalLogger = { [level in LogLevel]: (obj: any) => void };

export interface LogEvent {
    /** Log level */
    level: LogLevel;
    /** Timestamp */
    t: number;
    /** Connection ID */
    cid: string;
    /** Log order number */
    lo: number;
    /** Additional log data */
    [key: string]: any;
}

export interface ResponseEvent {
    /** Response type */
    response: string;
    /** Response code */
    code?: string | undefined;
}

/** Result object returned by ESEARCH (RFC 4731) when returnOptions is specified */
export interface ESearchResult {
    /** Total number of matching messages */
    count?: number | undefined;
    /** Lowest matching UID */
    min?: number | undefined;
    /** Highest matching UID */
    max?: number | undefined;
    /** All matching UIDs as compact sequence-set string (e.g. "1,5:10,20") */
    all?: string | undefined;
    /** Paged subset (RFC 9394 PARTIAL) */
    partial?:
        | {
              /** The requested range, e.g. "1:100" */
              range: string;
              /** Matching UIDs in that range as compact sequence-set */
              messages: string;
          }
        | undefined;
    /** Highest mod-sequence of the matching messages (RFC 7162, present when the search used a modseq criterion on a CONDSTORE session) */
    modseq?: bigint | undefined;
}

/** A single IMAP namespace entry as reported by the NAMESPACE command */
export interface NamespaceObject {
    /** Namespace prefix */
    prefix: string;
    /** Hierarchy delimiter. `null` when the server reported NIL (a flat namespace, RFC 2342 section 5), `undefined` when the LIST fallback could not determine it */
    delimiter: string | null | undefined;
}

/** Namespaces reported by the server, grouped by type. `other` and `shared` are `false` when the server reported none */
export interface NamespacesObject {
    personal: NamespaceObject[];
    other: NamespaceObject[] | false;
    shared: NamespaceObject[] | false;
}

/** Negotiated TLS session details, from `tls.TLSSocket#getCipher()` plus the authorization state */
export interface TlsInfo extends CipherNameAndProtocol {
    authorized?: boolean | undefined;
}

/**
 * Events emitted by an ImapFlow client
 */
export interface ImapFlowEvents {
    /** Connection close event */
    close: [];
    /** Error event */
    error: [error: Error];
    /** Message count in currently opened mailbox changed */
    exists: [data: ExistsEvent];
    /** Deleted message sequence number in currently opened mailbox */
    expunge: [data: ExpungeEvent];
    /** Flags were updated for a message */
    flags: [data: FlagsEvent];
    /** Mailbox was opened */
    mailboxOpen: [mailbox: MailboxObject];
    /** Mailbox was closed, either explicitly or because the connection went away while a mailbox was still selected */
    mailboxClose: [mailbox: MailboxObject];
    /** Log event if emitLogs=true */
    log: [entry: LogEvent];
    /** Response event */
    response: [response: ResponseEvent];
}
