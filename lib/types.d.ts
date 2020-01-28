declare module "imapflow" {
    /**
     * @typedef {Object} MailboxObject
     * @property {string} path - mailbox path
     * @property {string} delimiter - mailbox path delimiter, usually "." or "/"
     * @property {Set<string>} flags - list of flags for this mailbox
     * @property {string} [specialUse] - one of special-use flags (if applicable): "\All", "\Archive", "\Drafts", "\Flagged", "\Junk", "\Sent", "\Trash". Additionally INBOX has non-standard "\Inbox" flag set
     * @property {boolean} listed - *true* if mailbox was found from the output of LIST command
     * @property {boolean} subscribed - *true* if mailbox was found from the output of LSUB command
     * @property {Set<string>} permanentFlags - A Set of flags available to use in this mailbox. If it is not set or includes special flag "\\\*" then any flag can be used.
     * @property {string} [mailboxId] - unique mailbox ID if server has OBJECTID extension enabled
     * @property {BigInt} [highestModseq] - latest known modseq value if server has CONDSTORE or XYMHIGHESTMODSEQ enabled
     * @property {BigInt} uidValidity - Mailbox UIDVALIDITY value
     * @property {number} uidNext - Next predicted UID
     * @property {number} exists - Messages in this folder
     */
    declare type MailboxObject = {
        path: string;
        delimiter: string;
        flags: Set<string>;
        specialUse?: string;
        listed: boolean;
        subscribed: boolean;
        permanentFlags: Set<string>;
        mailboxId?: string;
        highestModseq?: bigint;
        uidValidity: bigint;
        uidNext: number;
        exists: number;
    };

    /**
     * @param {object} options - IMAP connection options
     * @param {string} options.host - Hostname of the IMAP server
     * @param {number} options.port - Port number for the IMAP server
     * @param {string} [options.secure=false] - Should the connection be established over TLS.
     *      If *false* then connection is upgraded to TLS using STARTTLS extension before authentication
     * @param {string} [options.servername] - Servername for SNI (or when host is set to an IP address)
     * @param {boolean} [options.disableCompression=false] - if *true* then client does not try to use COMPRESS=DEFLATE extension
     * @param {object} options.auth - Authentication options. Authentication is requested automatically during <code>connect()</code>
     * @param {object} options.auth.user - Usename
     * @param {object} options.auth.pass - Password
     * @param {Boolean} [options.disableAutoIdle=false] - if *true* then IDLE is not started automatically. Useful if you only need to perform specific tasks over the connection
     * @param {object} options.tls - Additional TLS options (see [Node.js TLS connect](https://nodejs.org/api/tls.html#tls_tls_connect_options_callback") for all available options)
     * @param {boolean} [options.tls.rejectUnauthorized=true] - if *false* then client accepts self-signed and expired certificates from the server
     * @param {string} [options.tls.minVersion=TLSv1.2] - latest Node.js defaults to *'TLSv1.2'*, for older mail servers you might need to use something else, eg *'TLSv1'*
     * @param {object} [options.logger] - Custom logger instance with `error(obj)` and `info(obj)` properties. If not provided then ImapFlow logs to console using pino format
     */
    declare class ImapFlow {
        constructor(options: {
            host: string;
            port: number;
            secure?: string;
            servername?: string;
            disableCompression?: boolean;
            auth: {
                user: any;
                pass: any;
            };
            disableAutoIdle?: boolean;
            tls: {
                rejectUnauthorized?: boolean;
                minVersion?: string;
            };
            logger?: any;
        });
        /**
         * Instance ID for logs
         * @type {String}
         */
        id: string;
        /**
         * Server identification info
         * @type {Object}
         */
        serverInfo: any;
        /**
         * Is the connection currently encrypted or not
         * @type {Boolean}
         */
        secureConnection: boolean;
        /**
         * Currently selected mailbox or *false* if mailbox is not open
         * @type {MailboxObject}
         */
        mailbox: MailboxObject;
        /**
         * Initiates a connection against IMAP server. Throws if anything goes wrong. This is something you have to call before you can run any IMAP commands
         *
         * @example
         * let client = new ImapFlow({...});
         * await client.connect();
         */
        connect(): void;
        /**
         * Graceful connection close by sending logout command to server. TCP connection is closed once command is finished.
         *
         * @example
         * let client = new ImapFlow({...});
         * await client.connect();
         * ...
         * await client.logout();
         */
        logout(): void;
        /**
         * Closes TCP connection without notifying the server.
         *
         * @example
         * let client = new ImapFlow({...});
         * await client.connect();
         * ...
         * client.close();
         */
        close(): void;
        /**
         * Returns current quota
         *
         * @param {string} [path] - Optional mailbox path if you want to check quota for specific folder
         * @returns {Boolean|QuotaResponse} - Quota information or *false* if QUTOA extension is not supported
         *
         * @example
         * let quota = await client.getQuota();
         * console.log(quota.storage.used, quota.storage.available)
         */
        getQuota(path?: string): boolean | QuotaResponse;
        /**
         * Lists available mailboxes as an Array
         *
         * @returns {ListResponse[]} - An array of ListResponse objects
         *
         * @example
         * let list = await client.list();
         * list.forEach(mailbox=>console.log(mailbox.path));
         */
        list(): ListResponse[];
        /**
         * Lists available mailboxes as a tree structured object
         *
         * @returns {ListTreeResponse} - Tree structured object
         *
         * @example
         * let tree = await client.listTree();
         * tree.folders.forEach(mailbox=>console.log(mailbox.path));
         */
        listTree(): ListTreeResponse;
        /**
         * Performs a no-op call against server
         */
        noop(): void;
        /**
         * Creates a new mailbox folder and sets up subscription for the created mailbox. Throws on error.
         *
         * @param {string|array} path - Full mailbox path. Unicode is allowed. If value is an array then it is joined using current delimiter symbols. Namespace prefix is added automatically if required.
         * @returns {MailboxCreateResponse} - Mailbox info
         *
         * @example
         * let info = await client.mailboxCreate(['parent', 'child']);
         * console.log(info.path);
         * // "INBOX.parent.child" // assumes "INBOX." as namespace prefix and "." as delimiter
         */
        mailboxCreate(path: string | any[]): MailboxCreateResponse;
        /**
         * Renames a mailbox. Throws on error.
         *
         * @param {string|array} path - Path for the mailbox to rename. Unicode is allowed. If value is an array then it is joined using current delimiter symbols. Namespace prefix is added automatically if required.
         * @param {string|array} newPath - New path for the mailbox
         * @returns {MailboxRenameResponse} - Mailbox info
         *
         * @example
         * let info = await client.mailboxRename('parent.child', 'Important stuff ❗️');
         * console.log(info.newPath);
         * // "INBOX.Important stuff ❗️" // assumes "INBOX." as namespace prefix
         */
        mailboxRename(path: string | any[], newPath: string | any[]): MailboxRenameResponse;
        /**
         * Deletes a mailbox. Throws on error.
         *
         * @param {string|array} path - Path for the mailbox to delete. Unicode is allowed. If value is an array then it is joined using current delimiter symbols. Namespace prefix is added automatically if required.
         * @returns {MailboxDeleteResponse} - Mailbox info
         *
         * @example
         * let info = await client.mailboxDelete('Important stuff ❗️');
         * console.log(info.path);
         * // "INBOX.Important stuff ❗️" // assumes "INBOX." as namespace prefix
         */
        mailboxDelete(path: string | any[]): MailboxDeleteResponse;
        /**
         * Subscribes to a mailbox
         *
         * @param {string|array} path - Path for the mailbox to subscribe to. Unicode is allowed. If value is an array then it is joined using current delimiter symbols. Namespace prefix is added automatically if required.
         * @returns {Boolean} - *true* if subscription operation succeeded, *false* otherwise
         *
         * @example
         * await client.mailboxSubscribe('Important stuff ❗️');
         */
        mailboxSubscribe(path: string | any[]): boolean;
        /**
         * Unsubscribes from a mailbox
         *
         * @param {string|array} path - **Path for the mailbox** to unsubscribe from. Unicode is allowed. If value is an array then it is joined using current delimiter symbols. Namespace prefix is added automatically if required.
         * @returns {Boolean} - *true* if unsubscription operation succeeded, *false* otherwise
         *
         * @example
         * await client.mailboxUnsubscribe('Important stuff ❗️');
         */
        mailboxUnsubscribe(path: string | any[]): boolean;
        /**
         * Opens a mailbox to access messages. You can perform message operations only against an opened mailbox.
         *
         * @param {string|array} path - **Path for the mailbox** to open
         * @param {object} [options] - optional options
         * @param {boolean} [options.readOnly=false] - If *true* then opens mailbox in read-only mode. You can still try to perform write operations but these would probably fail.
         * @returns {MailboxObject} - Mailbox info
         *
         * @example
         * let mailbox = await client.mailboxOpen('Important stuff ❗️');
         * console.log(mailbox.exists);
         * // 125
         */
        mailboxOpen(path: string | any[], options?: {
            readOnly?: boolean;
        }): MailboxObject;
        /**
         * Closes a previously opened mailbox
         *
         * @returns {Boolean} - Did the operation succeed or not
         *
         * @example
         * let mailbox = await client.mailboxOpen('INBOX');
         * await client.mailboxClose();
         */
        mailboxClose(): boolean;
        /**
         * Requests the status of the indicated mailbox. Only requested status values will be returned.
         *
         * @param {string} path - mailbox path to check for
         * @param {object} query - defines requested status items
         * @param {boolean} query.messages - if *true* request count of messages
         * @param {boolean} query.recent - if *true* request count of messages with \\Recent tag
         * @param {boolean} query.uidNext - if *true* request predicted next UID
         * @param {boolean} query.uidValidity - if *true* request mailbox UIDVALIDITY value
         * @param {boolean} query.unseen - if *true* request count of unseen messages
         * @param {boolean} query.highestModseq - if *true* request last known modseq value
         * @returns {StatusObject} - status of the indicated mailbox
         *
         * @example
         * let status = await client.status('INBOX', {unseen: true});
         * console.log(status.unseen);
         * // 123
         */
        status(path: string, query: {
            messages: boolean;
            recent: boolean;
            uidNext: boolean;
            uidValidity: boolean;
            unseen: boolean;
            highestModseq: boolean;
        }): StatusObject;
        /**
         * Starts listening for new or deleted messages from the currently opened mailbox. Only required if {@link ImapFlow#disableAutoIdle} is set to *true*
         * otherwise IDLE is started by default on connection inactivity.
         *
         * @returns {Boolean} - Did the operation succeed or not
         *
         * @example
         * let mailbox = await client.mailboxOpen('INBOX');
         *
         * await client.idle();
         */
        idle(): boolean;
        /**
         * Sets flags for a message or message range
         *
         * @param {SequenceString | SearchObject} range - Range to filter the messages
         * @param {string[]} - Array of flags to set. Only flags that are permitted to set are used, other flags are ignored
         * @param {object} [options]
         * @param {boolean} [options.uid] - If *true* then uses UID {@link SequenceString} instead of sequence numbers
         * @returns {Boolean} - Did the operation succeed or not
         *
         * @example
         * let mailbox = await client.mailboxOpen('INBOX');
         * // mark all unseen messages as seen (and remove other flags)
         * await client.messageFlagsSet({seen: false}, ['\Seen]);
         */
        messageFlagsSet(range: SequenceString | SearchObject, flags: string[], options?: {
            uid?: boolean;
        }): boolean;
        /**
         * Adds flags for a message or message range
         *
         * @param {SequenceString | SearchObject} range - Range to filter the messages
         * @param {string[]} - Array of flags to set. Only flags that are permitted to set are used, other flags are ignored
         * @param {object} [options]
         * @param {boolean} [options.uid] - If *true* then uses UID {@link SequenceString} instead of sequence numbers
         * @returns {Boolean} - Did the operation succeed or not
         *
         * @example
         * let mailbox = await client.mailboxOpen('INBOX');
         * // mark all unseen messages as seen (and keep other flags as is)
         * await client.messageFlagsAdd({seen: false}, ['\Seen]);
         */
        messageFlagsAdd(range: SequenceString | SearchObject, flags: string[], options?: {
            uid?: boolean;
        }): boolean;
        /**
         * Remove specific flags from a message or message range
         *
         * @param {SequenceString | SearchObject} range - Range to filter the messages
         * @param {string[]} - Array of flags to remove. Only flags that are permitted to set are used, other flags are ignored
         * @param {object} [options]
         * @param {boolean} [options.uid] - If *true* then uses UID {@link SequenceString} instead of sequence numbers
         * @returns {Boolean} - Did the operation succeed or not
         *
         * @example
         * let mailbox = await client.mailboxOpen('INBOX');
         * // mark all seen messages as unseen by removing \\Seen flag
         * await client.messageFlagsRemove({seen: true}, ['\Seen]);
         */
        messageFlagsRemove(range: SequenceString | SearchObject, flags: string[], options?: {
            uid?: boolean;
        }): boolean;
        /**
         * Delete messages from currently opened mailbox. Method does not indicate info about deleted messages,
         * instead you should be using {@link ImapFlow#expunge} event for this
         *
         * @param {SequenceString | SearchObject} range - Range to filter the messages
         * @param {object} [options]
         * @param {boolean} [options.uid] - If *true* then uses UID {@link SequenceString} instead of sequence numbers
         * @returns {Boolean} - Did the operation succeed or not
         *
         * @example
         * let mailbox = await client.mailboxOpen('INBOX');
         * // delete all seen messages
         * await client.messageDelete({seen: true});
         */
        messageDelete(range: SequenceString | SearchObject, options?: {
            uid?: boolean;
        }): boolean;
        /**
         * Appends a new message to a mailbox
         *
         * @param {string} path - Mailbox path to upload the message to
         * @param {string|Buffer} content - RFC822 formatted email message
         * @param {string[]} [flags] - an array of flags to be set for the uploaded message
         * @param {Date|string} [idate=now] - internal date to be set for the message
         * @returns {AppendResponseObject} - info about uploaded message
         *
         * @example
         * await client.append('INBOX', rawMessageBuffer, ['\\Seen'], new Date(2000, 1, 1));
         */
        append(path: string, content: string | Buffer, flags?: string[], idate?: Date | string): AppendResponseObject;
        /**
         * Copies messages from current mailbox to destination mailbox
         *
         * @param {SequenceString | SearchObject} range - Range of messages to copy
         * @param {string} destination - Mailbox path to copy the messages to
         * @param {object} [options]
         * @param {boolean} [options.uid] - If *true* then uses UID {@link SequenceString} instead of sequence numbers
         * @returns {CopyResponseObject} - info about copies messages
         *
         * @example
         * await client.mailboxOpen('INBOX');
         * // copy all messages to a mailbox called "Backup" (must exist)
         * let result = await client.messageCopy('1:*', 'Backup');
         * console.log('Copied %s messages', result.uidMap.size);
         */
        messageCopy(range: SequenceString | SearchObject, destination: string, options?: {
            uid?: boolean;
        }): CopyResponseObject;
        /**
         * Moves messages from current mailbox to destination mailbox
         *
         * @param {SequenceString | SearchObject} range - Range of messages to move
         * @param {string} destination - Mailbox path to move the messages to
         * @param {object} [options]
         * @param {boolean} [options.uid] - If *true* then uses UID {@link SequenceString} instead of sequence numbers
         * @returns {CopyResponseObject} - info about moved messages
         *
         * @example
         * await client.mailboxOpen('INBOX');
         * // move all messages to a mailbox called "Trash" (must exist)
         * let result = await client.messageMove('1:*', 'Trash');
         * console.log('Moved %s messages', result.uidMap.size);
         */
        messageMove(range: SequenceString | SearchObject, destination: string, options?: {
            uid?: boolean;
        }): CopyResponseObject;
        /**
         * Search messages from currently opened mailbox
         *
         * @param {SearchObject} query - Query to filter the messages
         * @param {object} [options]
         * @param {boolean} [options.uid] - If *true* then returns UID numbers instead of sequence numbers
         * @returns {number[]} - An array of sequence or UID numbers
         *
         * @example
         * let mailbox = await client.mailboxOpen('INBOX');
         * // find all unseen messages
         * let list = await client.search({seen: false});
         */
        search(query: SearchObject, options?: {
            uid?: boolean;
        }): number[];
        /**
         * Fetch messages from currently opened mailbox
         *
         * @param {SequenceString | SearchObject} range - Range of messages to fetch
         * @param {FetchQueryObject} query - Fetch query
         * @param {object} [options]
         * @param {boolean} [options.uid] - If *true* then uses UID numbers instead of sequence numbers for range
         * @yields {FetchMessageObject} Message data object
         *
         * @example
         * let mailbox = await client.mailboxOpen('INBOX');
         * // fetch UID for all messages in a mailbox
         * for await (let msg of client.fetch('1:*', {uid: true})){
         *     console.log(msg.uid);
         * }
         */
        fetch(range: SequenceString | SearchObject, query: FetchQueryObject, options?: {
            uid?: boolean;
        }): void;
        /**
         * Fetch a single message from currently opened mailbox
         *
         * @param {SequenceString} range - UID or sequence number for the message to fetch
         * @param {FetchQueryObject} query - Fetch query
         * @param {object} [options]
         * @param {boolean} [options.uid] - If *true* then uses UID number instead of sequence number for range
         * @returns {FetchMessageObject} Message data object
         *
         * @example
         * let mailbox = await client.mailboxOpen('INBOX');
         * // fetch UID for all messages in a mailbox
         * let lastMsg = await client.fetchOne('*', {uid: true})
         * console.log(lastMsg.uid);
         */
        fetchOne(range: SequenceString, query: FetchQueryObject, options?: {
            uid?: boolean;
        }): FetchMessageObject;
        /**
         * Download either full rfc822 formated message or a specific bodystructure part as a Stream.
         * Bodystructure parts are decoded so the resulting stream is a binary file. Text content
         * is automatically converted to UTF-8 charset.
         *
         * @param {SequenceString} range - UID or sequence number for the message to fetch
         * @param {string} [part] - If not set then downloads entire rfc822 formatted message, otherwise downloads specific bodystructure part
         * @param {object} [options]
         * @param {boolean} [options.uid] - If *true* then uses UID number instead of sequence number for range
         * @returns {DownloadObject} Download data object
         *
         * @example
         * let mailbox = await client.mailboxOpen('INBOX');
         * // download body part nr '1.2' from latest message
         * let {meta, stream} = await client.download('*', '1.2');
         * stream.pipe(fs.createWriteStream(meta.filename));
         */
        download(range: SequenceString, part?: string, options?: {
            uid?: boolean;
        }): DownloadObject;
    }

    /**
     * @typedef {Object} QuotaResponse
     * @property {string} path=INBOX - mailbox path this quota applies to
     * @property {Object} [storage] - Storage quota if provided by server
     * @property {number} [storage.used] - used storage in bytes
     * @property {number} [storage.limit] - total storage available
     * @property {Object} [messages] - Message count quota if provided by server
     * @property {number} [messages.used] - stored messages
     * @property {number} [messages.limit] - maximum messages allowed
     */
    declare type QuotaResponse = {
        path: string;
        storage?: {
            used?: number;
            limit?: number;
        };
        messages?: {
            used?: number;
            limit?: number;
        };
    };

    /**
     * @typedef {Object} ListResponse
     * @property {string} path - mailbox path
     * @property {string} name - mailbox name (last part of path after delimiter)
     * @property {string} delimiter - mailbox path delimiter, usually "." or "/"
     * @property {Set<string>} flags - a set of flags for this mailbox
     * @property {string} specialUse - one of special-use flags (if applicable): "\All", "\Archive", "\Drafts", "\Flagged", "\Junk", "\Sent", "\Trash". Additionally INBOX has non-standard "\Inbox" flag set
     * @property {boolean} listed - *true* if mailbox was found from the output of LIST command
     * @property {boolean} subscribed - *true* if mailbox was found from the output of LSUB command
     */
    declare type ListResponse = {
        path: string;
        name: string;
        delimiter: string;
        flags: Set<string>;
        specialUse: string;
        listed: boolean;
        subscribed: boolean;
    };

    /**
     * @typedef {Object} ListTreeResponse
     * @property {boolean} root - If *true* then this is root node without any additional properties besides *folders*
     * @property {string} path - mailbox path
     * @property {string} name - mailbox name (last part of path after delimiter)
     * @property {string} delimiter - mailbox path delimiter, usually "." or "/"
     * @property {array} flags - list of flags for this mailbox
     * @property {string} specialUse - one of special-use flags (if applicable): "\All", "\Archive", "\Drafts", "\Flagged", "\Junk", "\Sent", "\Trash". Additionally INBOX has non-standard "\Inbox" flag set
     * @property {boolean} listed - *true* if mailbox was found from the output of LIST command
     * @property {boolean} subscribed - *true* if mailbox was found from the output of LSUB command
     * @property {boolean} disabled - If *true* then this mailbox can not be selected in the UI
     * @property {ListTreeResponse[]} folders - An array of subfolders
     */
    declare type ListTreeResponse = {
        root: boolean;
        path: string;
        name: string;
        delimiter: string;
        flags: any[];
        specialUse: string;
        listed: boolean;
        subscribed: boolean;
        disabled: boolean;
        folders: ListTreeResponse[];
    };

    /**
     * @typedef {Object} MailboxCreateResponse
     * @property {string} path - full mailbox path
     * @property {string} [mailboxId] - unique mailbox ID if server supports OBJECTID extension (currently Yahoo and some others)
     */
    declare type MailboxCreateResponse = {
        path: string;
        mailboxId?: string;
    };

    /**
     * @typedef {Object} MailboxRenameResponse
     * @property {string} path - full mailbox path that was renamed
     * @property {string} newPath - new full mailbox path
     */
    declare type MailboxRenameResponse = {
        path: string;
        newPath: string;
    };

    /**
     * @typedef {Object} MailboxDeleteResponse
     * @property {string} path - full mailbox path that was deleted
     */
    declare type MailboxDeleteResponse = {
        path: string;
    };

    /**
     * @typedef {Object} StatusObject
     * @property {string} path - full mailbox path that was checked
     * @property {number} [messages] - Count of messages
     * @property {number} [recent] - Count of messages with \\Recent tag
     * @property {number} [uidNext] - Predicted next UID
     * @property {BigInt} [uidValidity] - Mailbox UIDVALIDITY value
     * @property {number} [unseen] - Count of unseen messages
     * @property {BigInt} [highestModseq] - Last known modseq value (if CONDSTORE extension is enabled)
     */
    declare type StatusObject = {
        path: string;
        messages?: number;
        recent?: number;
        uidNext?: number;
        uidValidity?: bigint;
        unseen?: number;
        highestModseq?: bigint;
    };

    /**
     * Sequence range string. Separate different values with commas, number ranges with colons and use \\* as the placeholder for the newest message in mailbox
     * @typedef {String} SequenceString
     * @example
     * "1:*" // for all messages
     * "1,2,3" // for messages 1, 2 and 3
     * "1,2,4:6" // for messages 1,2,4,5,6
     * "*" // for the newest message
     */
    declare type SequenceString = string;

    /**
     * IMAP search query options. By default all conditions must match. In case of `or` query term at least one condition must match.
     * @typedef {Object} SearchObject
     * @property {SequenceString} [seq] - message ordering sequence range
     * @property {boolean} [answered] - Messages with (value is *true*) or without (value is *false*) \\Answered flag
     * @property {boolean} [deleted] - Messages with (value is *true*) or without (value is *false*) \\Deleted flag
     * @property {boolean} [draft] - Messages with (value is *true*) or without (value is *false*) \\Draft flag
     * @property {boolean} [flagged] - Messages with (value is *true*) or without (value is *false*) \\Flagged flag
     * @property {boolean} [seen] - Messages with (value is *true*) or without (value is *false*) \\Seen flag
     * @property {boolean} [all] - If *true* matches all messages
     * @property {boolean} [new] - If *true* matches messages that have the \\Recent flag set but not the \\Seen flag
     * @property {boolean} [old] - If *true* matches messages that do not have the \\Recent flag set
     * @property {boolean} [recent] - If *true* matches messages that have the \\Recent flag set
     * @property {string} [from] - Matches From: address field
     * @property {string} [to] - Matches To: address field
     * @property {string} [cc] - Matches Cc: address field
     * @property {string} [bcc] - Matches Bcc: address field
     * @property {string} [body] - Matches message body
     * @property {string} [subject] - Matches message subject
     * @property {number} [larger] - Matches messages larger than value
     * @property {number} [smaller] - Matches messages smaller than value
     * @property {SequenceString} [uid] - UID sequence range
     * @property {BigInt} [modseq] - Matches messages with modseq higher than value
     * @property {string} [emailId] - unique email ID. Only used if server supports OBJECTID or X-GM-EXT-1 extensions
     * @property {string} [threadId] - unique thread ID. Only used if server supports OBJECTID or X-GM-EXT-1 extensions
     * @property {Date|string} [before] - Matches messages received before date
     * @property {Date|string} [on] - Matches messages received on date (ignores time)
     * @property {Date|string} [since] - Matches messages received after date
     * @property {Date|string} [sentBefore] - Matches messages sent before date
     * @property {Date|string} [sentOn] - Matches messages sent on date (ignores time)
     * @property {Date|string} [sentSince] - Matches messages sent after date
     * @property {string} [keyword] - Matches messages that have the custom flag set
     * @property {string} [unKeyword] - Matches messages that do not have the custom flag set
     * @property {Object.<string, Boolean|String>} [header] - Mathces messages with header key set (if value is *true*) or messages where header partially matches (if value is a string)
     * @property {SearchObject[]} [or] - An array of 2 or more {@link SearchObject} objects. At least on of these must match
     */
    declare type SearchObject = {
        seq?: SequenceString;
        answered?: boolean;
        deleted?: boolean;
        draft?: boolean;
        flagged?: boolean;
        seen?: boolean;
        all?: boolean;
        new?: boolean;
        old?: boolean;
        recent?: boolean;
        from?: string;
        to?: string;
        cc?: string;
        bcc?: string;
        body?: string;
        subject?: string;
        larger?: number;
        smaller?: number;
        uid?: SequenceString;
        modseq?: bigint;
        emailId?: string;
        threadId?: string;
        before?: Date | string;
        on?: Date | string;
        since?: Date | string;
        sentBefore?: Date | string;
        sentOn?: Date | string;
        sentSince?: Date | string;
        keyword?: string;
        unKeyword?: string;
        header?: {
            [key: string]: Boolean | String;
        };
        or?: SearchObject[];
    };

    /**
     * @typedef {Object} AppendResponseObject
     * @property {string} path - full mailbox path where the message was uploaded to
     * @property {BigInt} [uidValidity] - mailbox UIDVALIDITY if server has UIDPLUS extension enabled
     * @property {number} [uid] - UID of the uploaded message if server has UIDPLUS extension enabled
     * @property {number} [seq] - sequence number of the uploaded message if path is currently selected mailbox
     */
    declare type AppendResponseObject = {
        path: string;
        uidValidity?: bigint;
        uid?: number;
        seq?: number;
    };

    /**
     * @typedef {Object} CopyResponseObject
     * @property {string} path - path of source mailbox
     * @property {string} destination - path of destination mailbox
     * @property {BigInt} [uidValidity] - destination mailbox UIDVALIDITY if server has UIDPLUS extension enabled
     * @property {Map<number, number>} [uidMap] - Map of UID values (if server has UIDPLUS extension enabled) where key is UID in source mailbox and value is the UID for the same message in destination mailbox
     */
    declare type CopyResponseObject = {
        path: string;
        destination: string;
        uidValidity?: bigint;
        uidMap?: Map<number, number>;
    };

    /**
     * @typedef {Object} FetchQueryObject
     * @property {boolean} [uid] - if *true* then include UID in the response
     * @property {boolean} [flags] - if *true* then include flags Set in the response
     * @property {boolean} [bodyStructure] - if *true* then include parsed BODYSTRUCTURE object in the response
     * @property {boolean} [envelope] - if *true* then include parsed ENVELOPE object in the response
     * @property {boolean} [internalDate] - if *true* then include internal date value in the response
     * @property {boolean} [size] - if *true* then include message size in the response
     * @property {boolean | Object} [source] - if *true* then include full message in the response
     * @property {number} [source.start] - include full message in the response starting from *start* byte
     * @property {number} [source.maxLength] - include full message in the response, up to *maxLength* bytes
     * @property {string} [threadId] - if *true* then include thread ID in the response (only if server supports either OBJECTID or X-GM-EXT-1 extensions)
     * @property {boolean} [labels] - if *true* then include GMail labels in the response (only if server supports X-GM-EXT-1 extension)
     * @property {boolean | string[]} [headers] - if *true* then includes full headers of the message in the response. If the value is an array of header keys then includes only headers listed in the array
     * @property {string[]} [bodyParts] - An array of BODYPART identifiers to include in the response
     */
    declare type FetchQueryObject = {
        uid?: boolean;
        flags?: boolean;
        bodyStructure?: boolean;
        envelope?: boolean;
        internalDate?: boolean;
        size?: boolean;
        source?: {
            start?: number;
            maxLength?: number;
        };
        threadId?: string;
        labels?: boolean;
        headers?: boolean | string[];
        bodyParts?: string[];
    };

    /**
     * Parsed email address entry
     *
     * @typedef {Object} MessageAddressObject
     * @property {string} [name] - name of the address object (unicode)
     * @property {string} [address] - email address
     */
    declare type MessageAddressObject = {
        name?: string;
        address?: string;
    };

    /**
     * Parsed IMAP ENVELOPE object
     *
     * @typedef {Object} MessageEnvelopeObject
     * @property {Date} [date] - header date
     * @property {string} [subject] - message subject (unicode)
     * @property {string} [messageId] - Message ID of the message
     * @property {string} [inReplyTo] - Message ID from In-Reply-To header
     * @property {MessageAddressObject[]} [from] - Array of addresses from the From: header
     * @property {MessageAddressObject[]} [sender] - Array of addresses from the Sender: header
     * @property {MessageAddressObject[]} [replyTo] - Array of addresses from the Reply-To: header
     * @property {MessageAddressObject[]} [to] - Array of addresses from the To: header
     * @property {MessageAddressObject[]} [cc] - Array of addresses from the Cc: header
     * @property {MessageAddressObject[]} [bcc] - Array of addresses from the Bcc: header
     */
    declare type MessageEnvelopeObject = {
        date?: Date;
        subject?: string;
        messageId?: string;
        inReplyTo?: string;
        from?: MessageAddressObject[];
        sender?: MessageAddressObject[];
        replyTo?: MessageAddressObject[];
        to?: MessageAddressObject[];
        cc?: MessageAddressObject[];
        bcc?: MessageAddressObject[];
    };

    /**
     * Parsed IMAP BODYSTRUCTURE object
     *
     * @typedef {Object} MessageStructureObject
     * @property {string} part - Body part number. This value can be used to later fetch the contents of this part of the message
     * @property {string} type - Content-Type of this node
     * @property {object} [parameters] - Additional parameters for Content-Type, eg "charset"
     * @property {string} [id] - Content-ID
     * @property {string} [encoding] - Transfer encoding
     * @property {number} [size] - Expected size of the node
     * @property {MessageEnvelopeObject} [envelope] - message envelope of embedded RFC822 message
     * @property {string} [disposition] - Content disposition
     * @property {object} [dispositionParameters] - Additional parameters for Conent-Disposition
     * @property {MessageStructureObject[]} childNodes An array of child nodes if this is a multipart node. Not present for normal nodes
     */
    declare type MessageStructureObject = {
        part: string;
        type: string;
        parameters?: any;
        id?: string;
        encoding?: string;
        size?: number;
        envelope?: MessageEnvelopeObject;
        disposition?: string;
        dispositionParameters?: any;
        childNodes: MessageStructureObject[];
    };

    /**
     * Fetched message data
     *
     * @typedef {Object} FetchMessageObject
     * @property {number} seq - message sequence number. Always included in the response
     * @property {number} uid - message UID number. Always included in the response
     * @property {Buffer} [source] - message source for the requested byte range
     * @property {BigInt} [modseq] - message Modseq number. Always included if the server supports CONDSTORE extension
     * @property {string} [emailId] - unique email ID. Always included if server supports OBJECTID or X-GM-EXT-1 extensions
     * @property {string} [threadid] - unique thread ID. Only present if server supports OBJECTID or X-GM-EXT-1 extension
     * @property {Set<string>} [labels] - a Set of labels. Only present if server supports X-GM-EXT-1 extension
     * @property {number} [size] - message size
     * @property {Set<string>} [flags] - a set of message flags
     * @property {MessageEnvelopeObject} [envelope] - message envelope
     * @property {MessageStructureObject} [bodyStructure] - message body structure
     * @property {Date} [internalDate] - message internal date
     * @property {Map<string, Buffer>} [bodyParts] - a Map of message body parts where key is requested part identifier and value is a Buffer
     * @property {Buffer} [headers] - Requested header lines as Buffer
     */
    declare type FetchMessageObject = {
        seq: number;
        uid: number;
        source?: Buffer;
        modseq?: bigint;
        emailId?: string;
        threadid?: string;
        labels?: Set<string>;
        size?: number;
        flags?: Set<string>;
        envelope?: MessageEnvelopeObject;
        bodyStructure?: MessageStructureObject;
        internalDate?: Date;
        bodyParts?: Map<string, Buffer>;
        headers?: Buffer;
    };

    /**
     * @typedef {Object} DownloadObject
     * @property {Object} meta - content metadata
     * @property {string} meta.contentType - Content-Type of the streamed file. If part was not set then this value is "message/rfc822"
     * @property {string} [meta.charset] - Charset of the body part. Text parts are automaticaly converted to UTF-8, attachments are kept as is
     * @property {string} [meta.disposition] - Content-Disposition of the streamed file
     * @property {string} [meta.filename] - Filename of the streamed body part
     * @property {ReadableStream} content - Streamed content
     */
    declare type DownloadObject = {
        meta: {
            contentType: string;
            charset?: string;
            disposition?: string;
            filename?: string;
        };
        content: ReadableStream;
    };

}