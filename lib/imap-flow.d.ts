import { EventEmitter } from 'events';
import { TlsOptions } from 'tls';
import { Readable } from 'stream';

export interface ImapFlowOptions {
    /** Hostname of the IMAP server */
    host: string;
    /** Port number for the IMAP server */
    port: number;
    /** If true, the connection will use TLS. If false, then TLS is used only if the server supports STARTTLS extension */
    secure?: boolean;
    /** Servername for SNI (or when host is set to an IP address) */
    servername?: string;
    /** If true, do not use COMPRESS=DEFLATE extension even if server supports it */
    disableCompression?: boolean;
    /** Authentication options */
    auth?: {
        /** Username */
        user: string;
        /** Password for regular authentication (if using OAuth2 then use `accessToken` instead) */
        pass?: string;
        /** OAuth2 access token, if using OAuth2 authentication */
        accessToken?: string;
        /** Optional login method override. Set to 'LOGIN', 'AUTH=LOGIN' or 'AUTH=PLAIN' to use specific method */
        loginMethod?: string;
        /** Authorization identity for SASL PLAIN (used for admin impersonation/delegation). When set, authenticates as `user` but authorizes as `authzid` */
        authzid?: string;
    };
    /** Client identification info sent to the server if server supports ID extension */
    clientInfo?: IdInfoObject;
    /** If true, then do not start IDLE when connection is established */
    disableAutoIdle?: boolean;
    /** Additional TLS options (see Node.js TLS documentation) */
    tls?: TlsOptions;
    /** Custom logger instance. Set to false to disable logging */
    logger?: Logger | false;
    /** If true, log data read and written to socket encoded in base64 */
    logRaw?: boolean;
    /** If true, emit 'log' events */
    emitLogs?: boolean;
    /** If true, then logs out automatically after successful authentication */
    verifyOnly?: boolean;
    /** If true and verifyOnly is set, lists mailboxes */
    includeMailboxes?: boolean;
    /** Proxy URL. Supports HTTP CONNECT (http:, https:) and SOCKS (socks:, socks4:, socks5:) proxies */
    proxy?: string;
    /** If true, then use QRESYNC instead of CONDSTORE. EXPUNGE notifications will include UID instead of sequence number */
    qresync?: boolean;
    /** If set, then breaks and restarts IDLE every maxIdleTime ms */
    maxIdleTime?: number;
    /** What command to run if IDLE is not supported. Defaults to 'NOOP' */
    missingIdleCommand?: 'NOOP' | 'SELECT' | 'STATUS';
    /** If true, ignores BINARY extension when making FETCH and APPEND calls */
    disableBinary?: boolean;
    /** If true, do not enable supported extensions */
    disableAutoEnable?: boolean;
    /** How long to wait for the connection to be established. Defaults to 90 seconds */
    connectionTimeout?: number;
    /** How long to wait for the greeting. Defaults to 16 seconds */
    greetingTimeout?: number;
    /** How long to wait for socket inactivity before timing out the connection. Defaults to 5 minutes */
    socketTimeout?: number;
    /** If true, uses TLS. If false, uses cleartext. If not set, upgrades to TLS if available */
    doSTARTTLS?: boolean;
    /** Custom instance ID string for logs */
    id?: string;
    /** Optional expunge event handler function */
    expungeHandler?: (event: ExpungeEvent) => Promise<void> | void;
}

export interface Logger {
    debug(obj: any): void;
    info(obj: any): void;
    warn(obj: any): void;
    error(obj: any): void;
}

export interface MailboxObject {
    /** Mailbox path */
    path: string;
    /** Mailbox path delimiter, usually "." or "/" */
    delimiter: string;
    /** List of flags for this mailbox */
    flags: Set<string>;
    /** One of special-use flags (if applicable): "\All", "\Archive", "\Drafts", "\Flagged", "\Junk", "\Sent", "\Trash". Additionally INBOX has non-standard "\Inbox" flag set */
    specialUse?: string;
    /** True if mailbox was found from the output of LIST command */
    listed?: boolean;
    /** True if mailbox was found from the output of LSUB command */
    subscribed?: boolean;
    /** A Set of flags available to use in this mailbox. If it is not set or includes special flag "\*" then any flag can be used */
    permanentFlags?: Set<string>;
    /** Unique mailbox ID if server has OBJECTID extension enabled */
    mailboxId?: string;
    /** Latest known modseq value if server has CONDSTORE or XYMHIGHESTMODSEQ enabled */
    highestModseq?: bigint;
    /** If true then the server doesn't support the persistent storage of mod-sequences for the mailbox */
    noModseq?: boolean;
    /** Mailbox UIDVALIDITY value */
    uidValidity: bigint;
    /** Next predicted UID */
    uidNext: number;
    /** Messages in this folder */
    exists: number;
    /** Read-only state */
    readOnly?: boolean;
}

export interface MailboxLockObject {
    /** Mailbox path */
    path: string;
    /** Release current lock */
    release(): void;
}

export interface IdInfoObject {
    /** Name of the program */
    name?: string;
    /** Version number of the program */
    version?: string;
    /** Name of the operating system */
    os?: string;
    /** Vendor of the client/server */
    vendor?: string;
    /** URL to contact for support */
    'support-url'?: string;
    /** Date program was released */
    date?: Date;
    [key: string]: any;
}

export interface QuotaResponse {
    /** Mailbox path this quota applies to */
    path: string;
    /** Storage quota if provided by server */
    storage?: {
        /** Used storage in bytes */
        used: number;
        /** Total storage available */
        limit: number;
    };
    /** Message count quota if provided by server */
    messages?: {
        /** Stored messages */
        used: number;
        /** Maximum messages allowed */
        limit: number;
    };
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
    specialUse?: string;
    /** True if mailbox was found from the output of LIST command */
    listed: boolean;
    /** True if mailbox was found from the output of LSUB command */
    subscribed: boolean;
    /** If statusQuery was used, then this value includes the status response */
    status?: StatusObject;
}

export interface ListOptions {
    /** Request status items for every listed entry */
    statusQuery?: {
        /** If true request count of messages */
        messages?: boolean;
        /** If true request count of messages with \Recent tag */
        recent?: boolean;
        /** If true request predicted next UID */
        uidNext?: boolean;
        /** If true request mailbox UIDVALIDITY value */
        uidValidity?: boolean;
        /** If true request count of unseen messages */
        unseen?: boolean;
        /** If true request last known modseq value */
        highestModseq?: boolean;
    };
    /** Set specific paths as special use folders */
    specialUseHints?: {
        /** Path to "Sent Mail" folder */
        sent?: string;
        /** Path to "Trash" folder */
        trash?: string;
        /** Path to "Junk Mail" folder */
        junk?: string;
        /** Path to "Drafts" folder */
        drafts?: string;
    };
}

export interface ListTreeResponse {
    /** If true then this is root node without any additional properties besides folders */
    root?: boolean;
    /** Mailbox path */
    path?: string;
    /** Mailbox name (last part of path after delimiter) */
    name?: string;
    /** Mailbox path delimiter, usually "." or "/" */
    delimiter?: string;
    /** List of flags for this mailbox */
    flags?: Set<string>;
    /** One of special-use flags (if applicable) */
    specialUse?: string;
    /** True if mailbox was found from the output of LIST command */
    listed?: boolean;
    /** True if mailbox was found from the output of LSUB command */
    subscribed?: boolean;
    /** If true then this mailbox can not be selected in the UI */
    disabled?: boolean;
    /** An array of subfolders */
    folders?: ListTreeResponse[];
    /** Status response */
    status?: StatusObject;
}

export interface MailboxCreateResponse {
    /** Full mailbox path */
    path: string;
    /** Unique mailbox ID if server supports OBJECTID extension */
    mailboxId?: string;
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
    messages?: number;
    /** Count of messages with \Recent tag */
    recent?: number;
    /** Predicted next UID */
    uidNext?: number;
    /** Mailbox UIDVALIDITY value */
    uidValidity?: bigint;
    /** Count of unseen messages */
    unseen?: number;
    /** Last known modseq value (if CONDSTORE extension is enabled) */
    highestModseq?: bigint;
}

export type SequenceString = string | number | bigint;

export interface SearchObject {
    /** Message ordering sequence range */
    seq?: SequenceString;
    /** Messages with (value is true) or without (value is false) \Answered flag */
    answered?: boolean;
    /** Messages with (value is true) or without (value is false) \Deleted flag */
    deleted?: boolean;
    /** Messages with (value is true) or without (value is false) \Draft flag */
    draft?: boolean;
    /** Messages with (value is true) or without (value is false) \Flagged flag */
    flagged?: boolean;
    /** Messages with (value is true) or without (value is false) \Seen flag */
    seen?: boolean;
    /** If true matches all messages */
    all?: boolean;
    /** If true matches messages that have the \Recent flag set but not the \Seen flag */
    new?: boolean;
    /** If true matches messages that do not have the \Recent flag set */
    old?: boolean;
    /** If true matches messages that have the \Recent flag set */
    recent?: boolean;
    /** Matches From: address field */
    from?: string;
    /** Matches To: address field */
    to?: string;
    /** Matches Cc: address field */
    cc?: string;
    /** Matches Bcc: address field */
    bcc?: string;
    /** Matches message body */
    body?: string;
    /** Matches message subject */
    subject?: string;
    /** Matches messages larger than value */
    larger?: number;
    /** Matches messages smaller than value */
    smaller?: number;
    /** UID sequence range */
    uid?: SequenceString;
    /** Matches messages with modseq higher than value */
    modseq?: bigint;
    /** Unique email ID. Only used if server supports OBJECTID or X-GM-EXT-1 extensions */
    emailId?: string;
    /** Unique thread ID. Only used if server supports OBJECTID or X-GM-EXT-1 extensions */
    threadId?: string;
    /** Matches messages received before date */
    before?: Date | string;
    /** Matches messages received on date (ignores time) */
    on?: Date | string;
    /** Matches messages received after date */
    since?: Date | string;
    /** Matches messages sent before date */
    sentBefore?: Date | string;
    /** Matches messages sent on date (ignores time) */
    sentOn?: Date | string;
    /** Matches messages sent after date */
    sentSince?: Date | string;
    /** Matches messages that have the custom flag set */
    keyword?: string;
    /** Matches messages that do not have the custom flag set */
    unKeyword?: string;
    /** Matches messages with header key set if value is true or messages where header partially matches a string value */
    header?: { [key: string]: boolean | string };
    /** A SearchObject object. It must not match */
    not?: SearchObject;
    /** An array of 2 or more SearchObject objects. At least one of these must match */
    or?: SearchObject[];
    /** Gmail raw search query (only for Gmail) */
    gmraw?: string;
    /** Gmail raw search query (alias for gmraw) */
    gmailraw?: string;
}

export interface FetchQueryObject {
    /** If true then include UID in the response */
    uid?: boolean;
    /** If true then include flags Set in the response */
    flags?: boolean;
    /** If true then include parsed BODYSTRUCTURE object in the response */
    bodyStructure?: boolean;
    /** If true then include parsed ENVELOPE object in the response */
    envelope?: boolean;
    /** If true then include internal date value in the response */
    internalDate?: boolean;
    /** If true then include message size in the response */
    size?: boolean;
    /** If true then include full message in the response */
    source?: boolean | {
        /** Include full message in the response starting from start byte */
        start?: number;
        /** Include full message in the response, up to maxLength bytes */
        maxLength?: number;
    };
    /** If true then include thread ID in the response (only if server supports either OBJECTID or X-GM-EXT-1 extensions) */
    threadId?: boolean;
    /** If true then include GMail labels in the response (only if server supports X-GM-EXT-1 extension) */
    labels?: boolean;
    /** If true then includes full headers of the message in the response. If the value is an array of header keys then includes only headers listed in the array */
    headers?: boolean | string[];
    /** An array of BODYPART identifiers to include in the response */
    bodyParts?: Array<string | { key: string; start?: number; maxLength?: number }>;
    /** Fast macro equivalent to flags, internalDate, size */
    fast?: boolean;
    /** All macro equivalent to flags, internalDate, size, envelope */
    all?: boolean;
    /** Full macro equivalent to flags, internalDate, size, envelope, bodyStructure */
    full?: boolean;
}

export interface MessageAddressObject {
    /** Name of the address object (unicode) */
    name?: string;
    /** Email address */
    address?: string;
}

export interface MessageEnvelopeObject {
    /** Header date */
    date?: Date;
    /** Message subject (unicode) */
    subject?: string;
    /** Message ID of the message */
    messageId?: string;
    /** Message ID from In-Reply-To header */
    inReplyTo?: string;
    /** Array of addresses from the From: header */
    from?: MessageAddressObject[];
    /** Array of addresses from the Sender: header */
    sender?: MessageAddressObject[];
    /** Array of addresses from the Reply-To: header */
    replyTo?: MessageAddressObject[];
    /** Array of addresses from the To: header */
    to?: MessageAddressObject[];
    /** Array of addresses from the Cc: header */
    cc?: MessageAddressObject[];
    /** Array of addresses from the Bcc: header */
    bcc?: MessageAddressObject[];
}

export interface MessageStructureObject {
    /** Body part number. This value can be used to later fetch the contents of this part of the message */
    part?: string;
    /** Content-Type of this node */
    type: string;
    /** Additional parameters for Content-Type, eg "charset" */
    parameters?: { [key: string]: string };
    /** Content-ID */
    id?: string;
    /** Transfer encoding */
    encoding?: string;
    /** Expected size of the node */
    size?: number;
    /** Message envelope of embedded RFC822 message */
    envelope?: MessageEnvelopeObject;
    /** Content disposition */
    disposition?: string;
    /** Additional parameters for Content-Disposition */
    dispositionParameters?: { [key: string]: string };
    /** An array of child nodes if this is a multipart node */
    childNodes?: MessageStructureObject[];
    /** MD5 hash */
    md5?: string;
    /** Language */
    language?: string[];
    /** Location */
    location?: string;
    /** Description */
    description?: string;
    /** Line count */
    lineCount?: number;
}

export interface FetchMessageObject {
    /** Message sequence number. Always included in the response */
    seq: number;
    /** Message UID number. Always included in the response */
    uid: number;
    /** Message source for the requested byte range */
    source?: Buffer;
    /** Message Modseq number. Always included if the server supports CONDSTORE extension */
    modseq?: bigint;
    /** Unique email ID. Always included if server supports OBJECTID or X-GM-EXT-1 extensions */
    emailId?: string;
    /** Unique thread ID. Only present if server supports OBJECTID or X-GM-EXT-1 extension */
    threadId?: string;
    /** A Set of labels. Only present if server supports X-GM-EXT-1 extension */
    labels?: Set<string>;
    /** Message size */
    size?: number;
    /** A set of message flags */
    flags?: Set<string>;
    /** Flag color like "red", or "yellow". This value is derived from the flags Set */
    flagColor?: string;
    /** Message envelope */
    envelope?: MessageEnvelopeObject;
    /** Message body structure */
    bodyStructure?: MessageStructureObject;
    /** Message internal date */
    internalDate?: Date | string;
    /** A Map of message body parts where key is requested part identifier and value is a Buffer */
    bodyParts?: Map<string, Buffer>;
    /** Requested header lines as Buffer */
    headers?: Buffer;
    /** Account unique ID for this email */
    id?: string;
}

export interface DownloadObject {
    /** Content metadata */
    meta: {
        /** The fetch response size */
        expectedSize: number;
        /** Content-Type of the streamed file */
        contentType: string;
        /** Charset of the body part */
        charset?: string;
        /** Content-Disposition of the streamed file */
        disposition?: string;
        /** Filename of the streamed body part */
        filename?: string;
        /** Transfer encoding */
        encoding?: string;
        /** If content uses flowed formatting */
        flowed?: boolean;
        /** If flowed text uses delSp */
        delSp?: boolean;
    };
    /** Streamed content */
    content: Readable;
}

export interface AppendResponseObject {
    /** Full mailbox path where the message was uploaded to */
    destination: string;
    /** Mailbox UIDVALIDITY if server has UIDPLUS extension enabled */
    uidValidity?: bigint;
    /** UID of the uploaded message if server has UIDPLUS extension enabled */
    uid?: number;
    /** Sequence number of the uploaded message if path is currently selected mailbox */
    seq?: number;
}

export interface CopyResponseObject {
    /** Path of source mailbox */
    path: string;
    /** Path of destination mailbox */
    destination: string;
    /** Destination mailbox UIDVALIDITY if server has UIDPLUS extension enabled */
    uidValidity?: bigint;
    /** Map of UID values where key is UID in source mailbox and value is the UID for the same message in destination mailbox */
    uidMap?: Map<number, number>;
}

export interface FetchOptions {
    /** If true then uses UID numbers instead of sequence numbers */
    uid?: boolean;
    /** If set then only messages with a higher modseq value are returned */
    changedSince?: bigint;
    /** If true then requests a binary response if the server supports this */
    binary?: boolean;
}

export interface StoreOptions {
    /** If true then uses UID numbers instead of sequence numbers */
    uid?: boolean;
    /** If set then only messages with a lower or equal modseq value are updated */
    unchangedSince?: bigint;
    /** If true then update Gmail labels instead of message flags */
    useLabels?: boolean;
    /** If true then does not emit 'flags' event */
    silent?: boolean;
}

export interface MailboxOpenOptions {
    /** If true then opens mailbox in read-only mode */
    readOnly?: boolean;
    /** Optional description for mailbox lock tracking */
    description?: string;
}

export interface ExpungeEvent {
    /** Mailbox path */
    path: string;
    /** Sequence number (if vanished is false) */
    seq?: number;
    /** UID number (if vanished is true or QRESYNC is enabled) */
    uid?: number;
    /** True if message was expunged using VANISHED response */
    vanished: boolean;
    /** True if VANISHED EARLIER response */
    earlier?: boolean;
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
    uid?: number;
    /** Updated modseq number for the mailbox */
    modseq?: bigint;
    /** A set of all flags for the updated message */
    flags: Set<string>;
    /** Flag color if message is flagged */
    flagColor?: string;
}

export interface LogEvent {
    /** Log level */
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
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
    code?: string;
}

export class AuthenticationFailure extends Error {
    authenticationFailed: true;
    serverResponseCode?: string;
    response?: string;
    oauthError?: any;
}

export class ImapFlow extends EventEmitter {
    /** Current module version */
    static version: string;

    /** Instance ID for logs */
    id: string;

    /** Server identification info */
    serverInfo: IdInfoObject | null;

    /** Is the connection currently encrypted or not */
    secureConnection: boolean;

    /** Active IMAP capabilities */
    capabilities: Map<string, boolean | number>;

    /** Enabled capabilities */
    enabled: Set<string>;

    /** Is the connection currently usable or not */
    usable: boolean;

    /** Currently authenticated user */
    authenticated: string | boolean;

    /** Currently selected mailbox */
    mailbox: MailboxObject | false;

    /** Is current mailbox idling */
    idling: boolean;

    constructor(options: ImapFlowOptions);

    /** Initiates a connection against IMAP server */
    connect(): Promise<void>;

    /** Graceful connection close by sending logout command to server */
    logout(): Promise<void>;

    /** Closes TCP connection without notifying the server */
    close(): void;

    /** Returns current quota */
    getQuota(path?: string): Promise<QuotaResponse | false>;

    /** Lists available mailboxes as an Array */
    list(options?: ListOptions): Promise<ListResponse[]>;

    /** Lists available mailboxes as a tree structured object */
    listTree(options?: ListOptions): Promise<ListTreeResponse>;

    /** Performs a no-op call against server */
    noop(): Promise<void>;

    /** Creates a new mailbox folder */
    mailboxCreate(path: string | string[]): Promise<MailboxCreateResponse>;

    /** Renames a mailbox */
    mailboxRename(path: string | string[], newPath: string | string[]): Promise<MailboxRenameResponse>;

    /** Deletes a mailbox */
    mailboxDelete(path: string | string[]): Promise<MailboxDeleteResponse>;

    /** Subscribes to a mailbox */
    mailboxSubscribe(path: string | string[]): Promise<boolean>;

    /** Unsubscribes from a mailbox */
    mailboxUnsubscribe(path: string | string[]): Promise<boolean>;

    /** Opens a mailbox to access messages */
    mailboxOpen(path: string | string[], options?: MailboxOpenOptions): Promise<MailboxObject>;

    /** Closes a previously opened mailbox */
    mailboxClose(): Promise<boolean>;

    /** Requests the status of the indicated mailbox */
    status(path: string, query: {
        messages?: boolean;
        recent?: boolean;
        uidNext?: boolean;
        uidValidity?: boolean;
        unseen?: boolean;
        highestModseq?: boolean;
    }): Promise<StatusObject>;

    /** Starts listening for new or deleted messages from the currently opened mailbox */
    idle(): Promise<boolean>;

    /** Sets flags for a message or message range */
    messageFlagsSet(range: SequenceString | number[] | SearchObject, flags: string[], options?: StoreOptions): Promise<boolean>;

    /** Adds flags for a message or message range */
    messageFlagsAdd(range: SequenceString | number[] | SearchObject, flags: string[], options?: StoreOptions): Promise<boolean>;

    /** Remove specific flags from a message or message range */
    messageFlagsRemove(range: SequenceString | number[] | SearchObject, flags: string[], options?: StoreOptions): Promise<boolean>;

    /** Sets a colored flag for an email */
    setFlagColor(range: SequenceString | number[] | SearchObject, color: string, options?: StoreOptions): Promise<boolean>;

    /** Delete messages from the currently opened mailbox */
    messageDelete(range: SequenceString | number[] | SearchObject, options?: { uid?: boolean }): Promise<boolean>;

    /** Appends a new message to a mailbox */
    append(path: string, content: string | Buffer, flags?: string[], idate?: Date | string): Promise<AppendResponseObject | false>;

    /** Copies messages from current mailbox to destination mailbox */
    messageCopy(range: SequenceString | number[] | SearchObject, destination: string, options?: { uid?: boolean }): Promise<CopyResponseObject | false>;

    /** Moves messages from current mailbox to destination mailbox */
    messageMove(range: SequenceString | number[] | SearchObject, destination: string, options?: { uid?: boolean }): Promise<CopyResponseObject | false>;

    /** Search messages from the currently opened mailbox */
    search(query: SearchObject, options?: { uid?: boolean }): Promise<number[] | false>;

    /** Fetch messages from the currently opened mailbox */
    fetch(range: SequenceString | number[] | SearchObject, query: FetchQueryObject, options?: FetchOptions): AsyncIterableIterator<FetchMessageObject>;

    /** Fetch all messages from the currently opened mailbox */
    fetchAll(range: SequenceString | number[] | SearchObject, query: FetchQueryObject, options?: FetchOptions): Promise<FetchMessageObject[]>;

    /** Fetch a single message from the currently opened mailbox */
    fetchOne(seq: SequenceString, query: FetchQueryObject, options?: FetchOptions): Promise<FetchMessageObject | false>;

    /** Download either full rfc822 formatted message or a specific bodystructure part as a Stream */
    download(range: SequenceString, part?: string, options?: {
        uid?: boolean;
        maxBytes?: number;
        chunkSize?: number;
    }): Promise<DownloadObject>;

    /** Fetch multiple attachments as Buffer values */
    downloadMany(range: SequenceString, parts: string[], options?: { uid?: boolean }): Promise<{
        [part: string]: {
            meta: {
                contentType?: string;
                charset?: string;
                disposition?: string;
                filename?: string;
                encoding?: string;
            };
            content: Buffer | null;
        }
    }>;

    /** Opens a mailbox if not already open and returns a lock */
    getMailboxLock(path: string | string[], options?: MailboxOpenOptions): Promise<MailboxLockObject>;

    /** Connection close event */
    on(event: 'close', listener: () => void): this;

    /** Error event */
    on(event: 'error', listener: (error: Error) => void): this;

    /** Message count in currently opened mailbox changed */
    on(event: 'exists', listener: (data: ExistsEvent) => void): this;

    /** Deleted message sequence number in currently opened mailbox */
    on(event: 'expunge', listener: (data: ExpungeEvent) => void): this;

    /** Flags were updated for a message */
    on(event: 'flags', listener: (data: FlagsEvent) => void): this;

    /** Mailbox was opened */
    on(event: 'mailboxOpen', listener: (mailbox: MailboxObject) => void): this;

    /** Mailbox was closed */
    on(event: 'mailboxClose', listener: (mailbox: MailboxObject) => void): this;

    /** Log event if emitLogs=true */
    on(event: 'log', listener: (entry: LogEvent) => void): this;

    /** Response event */
    on(event: 'response', listener: (response: ResponseEvent) => void): this;
}