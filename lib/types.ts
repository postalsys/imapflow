/**
 * Options for configuring the IMAP connection.
 */
export interface Options {
    /**
     * Hostname of the IMAP server.
     * @default "localhost"
     */
    host?: string;
    /**
     * Port number for the IMAP server. Defaults to either 993 (secure) or 110
     * (insecure).
     */
    port?: number;
    /**
     * Should the connection be established over TLS. If `false` then
     * connection is upgraded to TLS using STARTTLS extension before
     * authentication.
     * @default false
     */
    secure?: boolean;
    /**
     * Servername for SNI (or when host is set to an IP address).
     */
    servername?: string;
    /**
     * If `true` then client does not try to use COMPRESS=DEFLATE extension.
     * @default false
     */
    disableCompression?: boolean;
    /**
     * Authentication options. Authentication is requested automatically
     * during `connect()`.
     */
    auth?: {
        /**
         * Username.
         */
        user: string;
        /**
         * Password, if using regular authentication.
         */
        pass?: string;
        /**
         * OAuth2 Access Token, if using OAuth2 authentication.
         */
        accessToken?: string;
    };
    /**
     * Client identification info.
     */
    clientInfo?: IdInfoObject;
    /**
     * If `true` then IDLE is not started automatically. Useful if you only
     * need to perform specific tasks over the connection.
     * @default false
     */
    disableAutoIdle?: boolean;
    /**
     * Additional TLS options.
     */
    tls?: {
        /**
         * If `false` then client accepts self-signed and expired
         * certificates from the server.
         * @default true
         */
        rejectUnauthorized?: boolean;
        /**
         * Minimum TLS version to use.
         * @default TLSv1.2
         */
        minVersion?: string;
        /**
         * Minimum size of the DH parameter in bits to accept a TLS
         * connection.
         * @default 1024
         */
        minDHSize?: number;
    };
    /**
     * Custom logger instance with `debug(obj)`, `info(obj)`, `warn(obj)`,
     * and `error(obj)` methods. If not provided then ImapFlow logs to
     * console using pino format. Can be disabled by setting to `false`.
     * @default false
     */
    logger?:
        | {
              debug(obj: any): void;
              info(obj: any): void;
              warn(obj: any): void;
              error(obj: any): void;
          }
        | false;
    /**
     * If true then log data read from and written to socket encoded in
     * base64.
     * @default false
     */
    logRaw?: boolean;
    /**
     * If `true` then in addition to sending data to the logger, ImapFlow
     * emits 'log' events with the same data.
     * @default false
     */
    emitLogs?: boolean;
    /**
     * If `true` then logs out automatically after successful
     * authentication.
     * @default false
     */
    verifyOnly?: boolean;
    /**
     * Optional proxy URL. Supports HTTP CONNECT (`http://`, `https://`)
     * and SOCKS (`socks://`, `socks4://`, `socks5://`) proxies.
     */
    proxy?: string;
    /**
     * If true, then enables QRESYNC support. EXPUNGE notifications will
     * include `uid` property instead of `seq`.
     * @default false
     */
    qresync?: boolean;
    /**
     * If set, then breaks and restarts IDLE every maxIdleTime ms.
     */
    maxIdleTime?: number;
    /**
     * Which command to use if server does not support IDLE.
     * @default "NOOP"
     */
    missingIdleCommand?: string;
    /**
     * If true, then ignores the BINARY extension when making FETCH and
     * APPEND calls.
     * @default false
     */
    disableBinary?: boolean;
    /**
     * Do not enable supported extensions by default.
     */
    disableAutoEnable?: boolean;
    /**
     * How many milliseconds to wait for the connection to establish
     * (default is 90 seconds).
     */
    connectionTimeout?: number;
    /**
     * How many milliseconds to wait for the greeting after connection is
     * established (default is 16 seconds).
     */
    greetingTimeout?: number;
    /**
     * How many milliseconds of inactivity to allow (default is 5 minutes).
     */
    socketTimeout?: number;
    /**
     * Instance ID for logs.
     */
    id?: string;
    /**
     * List mailboxes before logout (only when `verifyOnly` is enabled).
     */
    includeMailboxes?: boolean;
    /**
     * Handler for untagged EXPUNGE responses.
     */
    expungeHandler?: (payload: any) => void;
}

/**
 * Represents a mailbox object with its properties.
 */
export type MailboxObject = {
    /** Mailbox path */
    path: string;

    /** Mailbox path delimiter, usually "." or "/" */
    delimiter: string;

    /** List of flags for this mailbox (e.g., `\Seen`, `\Draft`) */
    flags: Set<string>;

    /** Special-use flag like `\All`, `\Drafts`, `\Sent`, etc. */
    specialUse?: string;

    /** `true` if mailbox was found from the output of LIST command */
    listed: boolean;

    /** `true` if mailbox was found from the output of LSUB command */
    subscribed: boolean;

    /** A Set of flags available to use in this mailbox. If it is not set or includes special flag "\\\*" then any flag can be used. */
    permanentFlags: Set<string>;

    /** Unique mailbox ID if server has `OBJECTID` extension enabled */
    mailboxId?: string;

    /** Latest known modseq value if server has CONDSTORE or XYMHIGHESTMODSEQ enabled */
    highestModseq?: bigint;

    /** If true then the server doesn't support the persistent storage of mod-sequences for the mailbox */
    noModseq?: string;

    /** Mailbox `UIDVALIDITY` value */
    uidValidity: bigint;

    /** Next predicted UID */
    uidNext: number;

    /** Number of messages in this folder */
    exists: number;

    readOnly?: boolean;
};

/**
 * Represents a lock on a mailbox.
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
export type MailboxLockObject = {
    /** Mailbox path */
    path: string;

    /** Function to release the lock */
    release: (...params: any[]) => any;
};

/**
 * Client/server identification object, where key is one of RFC2971 defined [data fields](https://tools.ietf.org/html/rfc2971#section-3.3) (but not limited to).
 */
export type IdInfoObject = {
    /** Program name */
    name?: string;

    /** Program version */
    version?: string;

    /** Operating system name */
    os?: string;

    /** Client/server vendor */
    vendor?: string;

    /** URL for support */
    'support-url'?: string;

    /** Program release date */
    date?: Date;
};
/**
 * Represents quota information for a mailbox.
 */
export type QuotaResponse = {
    /** Mailbox path */
    path: string;

    /** Storage quota details */
    storage?: {
        /** Used storage in bytes */
        used?: number;

        /** Total storage available */
        limit?: number;
    };

    /** Message count quota details */
    messages?: {
        /** Number of stored messages */
        used?: number;

        /** Maximum messages allowed */
        limit?: number;
    };
};

export type SpecialUseFlag = (string & {}) | '\\All' | '\\Archive' | '\\Drafts' | '\\Flagged' | '\\Junk' | '\\Sent' | '\\Trash';

/**
 * Options for listing mailboxes.
 */
export type ListOptions = {
    /**
     * Query for specific mailbox status information.
     */
    statusQuery?: {
        /**
         * Include the number of messages in the mailbox.
         */
        messages?: boolean;
        /**
         * Include the number of recent messages in the mailbox.
         */
        recent?: boolean;
        /**
         * Include the UID of the next message that will be added to the mailbox.
         */
        uidNext?: boolean;
        /**
         * Include the UID validity value of the mailbox.
         */
        uidValidity?: boolean;
        /**
         * Include the number of unseen messages in the mailbox.
         */
        unseen?: boolean;
        /**
         * Include the highest modseq value of the mailbox.
         */
        highestModseq?: boolean;
    };
    /**
     * Hints for special mailbox usage.
     */
    specialUseHints?: {
        /**
         * The special mailbox used for sent messages.
         */
        sent?: string;
        /**
         * The special mailbox used for deleted messages.
         */
        trash?: string;
        /**
         * The special mailbox used for junk messages.
         */
        junk?: string;
        /**
         * The special mailbox used for draft messages.
         */
        drafts?: string;
    };
};

/**
 * Represents information about a mailbox from LIST/LSUB commands.
 */
export type ListResponse = {
    /** Mailbox path (unicode) */
    path: string;

    /** Path as listed in LIST/LSUB response */
    pathAsListed: string;

    /** Mailbox name (last part of path after delimiter) */
    name: string;

    /** Mailbox path delimiter, usually "." or "/" */
    delimiter: string;

    /** Array of parent folder names (unicode) */
    parent: string[];

    /** Parent folders as a string path (unicode) */
    parentPath: string;

    /** Set of flags for this mailbox */
    flags: Set<string>;

    /** Special-use flag. One of: `\All`, `\Archive`, `\Drafts`, `\Flagged`, `\Junk`, `\Sent`, `\Trash`. Additionally INBOX has non-standard `\Inbox` flag set */
    specialUse: SpecialUseFlag;

    /** `true` if found via LIST command */
    listed: boolean;

    /** `true` if found via LSUB command */
    subscribed: boolean;

    /** Status response if `statusQuery` was used */
    status?: StatusObject;
};

/**
 * Represents a mailbox tree structure.
 */
export type ListTreeResponse = {
    /** `true` if this is the root node without any additional properties besides _folders_ */
    root: boolean;

    /** Mailbox path */
    path: string;

    /** Mailbox name */
    name: string;

    /** Mailbox path delimiter, usually "." or "/" */
    delimiter: string;

    /** List of flags for this mailbox */
    flags: any[];

    /** Special-use flag. One of: `\All`, `\Archive`, `\Drafts`, `\Flagged`, `\Junk`, `\Sent`, `\Trash`. Additionally INBOX has non-standard `\Inbox` flag set */
    specialUse: SpecialUseFlag;

    /** `true` if found via LIST command */
    listed: boolean;

    /** `true` if found via LSUB command */
    subscribed: boolean;

    /** `true` if mailbox cannot be selected in the UI */
    disabled: boolean;

    /** Array of subfolders */
    folders: ListTreeResponse[];
};

export type MailboxOpenOptions = {
    /** If `true` then the mailbox is opened in read-only mode. You can still try to perform write operations but they will probably fail */
    readOnly?: boolean;
};

/**
 * Response for mailbox creation.
 */
export type MailboxCreateResponse = {
    /** Full mailbox path */
    path: string;

    /** Unique ID if server supports `OBJECTID` extension (e.g., Yahoo and some others) */
    mailboxId?: string;

    /** `true` if mailbox was created, `false` if it existed */
    created: boolean;
};

/**
 * Response for mailbox rename.
 */
export type MailboxRenameResponse = {
    /** Original full mailbox path */
    path: string;

    /** New full mailbox path */
    newPath: string;
};

/**
 * Response for mailbox deletion.
 */
export type MailboxDeleteResponse = {
    /** Full mailbox path that was deleted */
    path: string;
};

export type StatusQuery = {
    /** Include the number of messages in the mailbox */
    messages?: boolean;

    /** Include the number of messages with `\Recent` flag */
    recent?: boolean;

    /** Include the predicted next UID value */
    uidNext?: boolean;

    /** Include the UIDVALIDITY value of the mailbox */
    uidValidity?: boolean;

    /** Include the number of unseen messages in the mailbox */
    unseen?: boolean;

    /** Include the highest modseq value of the mailbox */
    highestModseq?: boolean;
};

/**
 * Represents mailbox status information.
 */
export type StatusObject = {
    /** Full mailbox path */
    path: string;

    /** Number of messages */
    messages?: number;

    /** Number of messages with `\Recent` flag */
    recent?: number;

    /** Predicted next UID */
    uidNext?: number;

    /** Mailbox UIDVALIDITY value */
    uidValidity?: bigint;

    /** Number of unseen messages */
    unseen?: number;

    /** Last known modseq value (if CONDSTORE extension is enabled) */
    highestModseq?: bigint;
};

/**
 * String representing a sequence range of messages in a mailbox.
 * @example
 * "1:*" // for all messages
 * "1,2,3" // for messages 1, 2 and 3
 * "1,2,4:6" // for messages 1,2,4,5,6
 * "*" // for the newest message
 */
export type SequenceString = string;

/**
 * Options for IMAP search queries. By default, all conditions must match. In case of an `or` query term, at least one condition must match.
 */
export type SearchObject = {
    /** Message sequence range */
    seq?: SequenceString;

    /** Filter by `\Answered` flag */
    answered?: boolean;

    /** Filter by `\Deleted` flag */
    deleted?: boolean;

    /** Filter by `\Draft` flag */
    draft?: boolean;

    /** Filter by `\Flagged` flag */
    flagged?: boolean;

    /** Filter by `\Seen` flag */
    seen?: boolean;

    /** Match all messages */
    all?: boolean;

    /** Match messages with `\Recent` but not `\Seen` flag */
    new?: boolean;

    /** Match messages without `\Recent` flag */
    old?: boolean;

    /** Match messages with `\Recent` flag */
    recent?: boolean;

    /** Match sender address */
    from?: string;

    /** Match recipient address */
    to?: string;

    /** Match CC address */
    cc?: string;

    /** Match BCC address */
    bcc?: string;

    /** Match message body text */
    body?: string;

    /** Match message subject */
    subject?: string;

    /** Match messages larger than specified size */
    larger?: number;

    /** Match messages smaller than specified size */
    smaller?: number;

    /** UID sequence range */
    uid?: SequenceString;

    /** Match messages with modseq higher than value */
    modseq?: bigint;

    /** Match unique email ID (only if server supports `OBJECTID` or `X-GM-EXT-1` extensions) */
    emailId?: string;

    /** Match unique thread ID (only if server supports `OBJECTID` or `X-GM-EXT-1` extensions) */
    threadId?: string;

    /** Match messages received before date */
    before?: Date | string;

    /** Match messages received on date (ignoring time) */
    on?: Date | string;

    /** Match messages received after date */
    since?: Date | string;

    /** Match messages sent before date */
    sentBefore?: Date | string;

    /** Match messages sent on date (ignoring time) */
    sentOn?: Date | string;

    /** Match messages sent after date */
    sentSince?: Date | string;

    /** Match messages with specific custom flag */
    keyword?: string;

    /** Match messages without specific custom flag */
    unKeyword?: string;

    /** Match messages based on header key/value */
    header?: {
        [key: string]: Boolean | String;
    };

    /** Array of SearchObjects, at least one must match */
    or?: SearchObject[];
};

/**
 * Response for message append operation.
 */
export type AppendResponseObject = {
    /** Mailbox path where message was uploaded */
    destination: string;

    /** Destination mailbox UIDVALIDITY (if server has `UIDPLUS` extension enabled) */
    uidValidity?: bigint;

    /** UID of uploaded message (if server has `UIDPLUS` extension enabled) */
    uid?: number;

    /** Sequence number of uploaded message (if path is currently selected mailbox) */
    seq?: number;
};

/**
 * Response for message copy operation.
 */
export type CopyResponseObject = {
    /** Source mailbox path */
    path: string;

    /** Destination mailbox path */
    destination: string;

    /** Destination mailbox UIDVALIDITY (if server has `UIDPLUS` extension enabled) */
    uidValidity?: bigint;

    /** Map of UIDs from source to destination (if server has `UIDPLUS` extension enabled) */
    uidMap?: Map<number, number>;
};

/**
 * Options for fetching message data.
 */
export type FetchQueryObject = {
    /** Include UID in response */
    uid?: boolean;

    /** Include flags and `flagColor` in response */
    flags?: boolean;

    /** Include parsed BODYSTRUCTURE */
    bodyStructure?: boolean;

    /** Include parsed ENVELOPE */
    envelope?: boolean;

    /** Include internal date */
    internalDate?: boolean;

    /** Include message size */
    size?: boolean;

    /** Include full message or a range */
    source?:
        | boolean
        | {
              /** Include full message starting from *start* byte */
              start?: number;

              /** Include full message, up to *maxLength* bytes */
              maxLength?: number;
          };

    /** Include thread ID (only if server supports `OBJECTID` or `X-GM-EXT-1` extensions) */
    threadId?: boolean;

    /** Include GMail labels (only if server supports `X-GM-EXT-1` extension) */
    labels?: boolean;

    /** Include all or specific headers. If an array of header keys is provided, only those headers are included */
    headers?: boolean | string[];

    /** An array of BODYPART identifiers to include in the response */
    bodyParts?: string[];
};

/**
 * Common options for IMAP message operations.
 */
export type MessageOptions = {
    /** If `true` then uses UID {@link SequenceString} instead of sequence numbers */
    uid?: boolean;
};

export type FetchOptions = MessageOptions & {
    /** If set then only messages with a lower or equal `modseq` value are fetched. Ignored if server does not support `CONDSTORE` extension. */
    changedSince?: bigint;

    /**
     * Request a binary response if the server supports it.
     * @default false
     */
    binary?: boolean;
};

/**
 * Parsed email address.
 */
export type MessageAddressObject = {
    /** Name of address object (unicode) */
    name?: string;

    /** Email address */
    address?: string;
};

/**
 * Parsed IMAP ENVELOPE object.
 */
export type MessageEnvelopeObject = {
    /** Header date */
    date?: Date;

    /** Message subject (unicode) */
    subject?: string;

    /** Message ID */
    messageId?: string;

    /** Message ID from `In-Reply-To` header */
    inReplyTo?: string;

    /** Array of addresses from the `From:` header */
    from?: MessageAddressObject[];

    /** Array of addresses from the `Sender:` header */
    sender?: MessageAddressObject[];

    /** Array of addresses from the `Reply-To:` header */
    replyTo?: MessageAddressObject[];

    /** Array of addresses from the `To:` header */
    to?: MessageAddressObject[];

    /** Array of addresses from the `Cc:` header */
    cc?: MessageAddressObject[];

    /** Array of addresses from the `Bcc:` header */
    bcc?: MessageAddressObject[];
};

/**
 * Parsed IMAP BODYSTRUCTURE object.
 */
export type MessageStructureObject = {
    /** Body part number. This value can be used to later fetch the contents of this part of the message */
    part: string;

    /** Content-Type of this node */
    type: string;

    /** Additional parameters for Content-Type (e.g., "charset") */
    parameters?: any;

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

    /** Additional parameters for Conent-Disposition */
    dispositionParameters?: any;

    /** An array of child nodes if this is a multipart node */
    childNodes?: MessageStructureObject[];
};

export type MessageFlagsOptions = MessageOptions & {
    /** If set then only messages with a lower or equal `modseq` value are updated. Ignored if server does not support `CONDSTORE` extension. */
    unchangedSince?: bigint;

    /** If true then update Gmail labels instead of message flags */
    useLabels?: boolean;
};

/**
 * Fetched message data.
 */
export type FetchMessageObject = {
    /** Message sequence number */
    seq: number;

    /** Message UID number */
    uid: number;

    /** Message source for the requested byte range */
    source?: Buffer;

    /** Message Modseq number (only if server supports `CONDSTORE` extension) */
    modseq?: bigint;

    /** Unique email ID (only if server supports `OBJECTID` or `X-GM-EXT-1` extensions) */
    emailId?: string;

    /** Unique thread ID (only if server supports `OBJECTID` or `X-GM-EXT-1` extensions) */
    threadid?: string;

    /** Set of labels (only if server supports `X-GM-EXT-1` extension) */
    labels?: Set<string>;

    /** Message size */
    size?: number;

    /** Set of message flags */
    flags?: Set<string>;

    /** Flag color based on flags (e.g., "red", "yellow"). This value is derived from the `flags` Set and it uses the same color rules as Apple Mail */
    flagColor?: string;

    /** Message envelope */
    envelope?: MessageEnvelopeObject;

    /** Message body structure */
    bodyStructure?: MessageStructureObject;

    /** Message internal date */
    internalDate?: Date;

    /** Map of requested body parts where key is requested part identifier and value is a Buffer */
    bodyParts?: Map<string, Buffer>;

    /** Requested header lines as Buffer */
    headers?: Buffer;
};

/**
 * Download either full rfc822 formated message or a specific bodystructure part as a Stream.
 * Bodystructure parts are decoded so the resulting stream is a binary file. Text content
 * is automatically converted to UTF-8 charset.
 *
 * @param range UID or sequence number for the message to fetch
 * @param [part] If not set then downloads entire rfc822 formatted message, otherwise downloads specific bodystructure part
 * @param [options]
 * @param [options.uid] If `true` then uses UID number instead of sequence number for `range`
 * @param [options.maxBytes] If set then limits download size to specified bytes
 * @param [options.chunkSize=65536] How large content parts to ask from the server
 * @returns Download data object
 *
 * @example
 * let mailbox = await client.mailboxOpen('INBOX');
 * // download body part nr '1.2' from latest message
 * let {meta, content} = await client.download('*', '1.2');
 * content.pipe(fs.createWriteStream(meta.filename));
 */
export type DownloadOptions = MessageOptions & {
    /** Limit download size to specified bytes */
    maxBytes?: number;

    /** How large content parts to ask from the server. Default is 65536 bytes (64KB). */
    chunkSize?: number;
};

/**
 * Represents a streamed message download.
 */
export type DownloadObject = {
    /** Content metadata */
    meta: {
        /** Expected size of the download */
        expectedSize: number;

        /** Content-Type of the streamed file. If part was not set then this value is "message/rfc822" */
        contentType: string;

        /** Charset of the body part. Text parts are automaticaly converted to UTF-8, attachments are kept as is */
        charset?: string;

        /** Content-Disposition of the streamed file */
        disposition?: string;

        /** Filename of the streamed body part */
        filename?: string;
    };

    /** Streamed content */
    content: NodeJS.ReadableStream;
};
