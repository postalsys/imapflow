'use strict';

/**
 * @class EventEmitter
 */

/**
 * Adds a listener to the end of the listeners array for the specified event.
 * No checks are made to see if the listener has already been added. Multiple
 * calls passing the same combination of event and listener will result in the
 * listener being added multiple times.
 * @function EventEmitter#on
 * @param {string} event The event to listen for.
 * @param {Function} listener The function to invoke.
 * @return {EventEmitter} for call chaining.
 */

/**
 * Alias for {@link EventEmitter#on}.
 * @function EventEmitter#addListener
 * @param {string} event The event to listen for.
 * @param {Function} listener The function to invoke.
 * @return {EventEmitter} for call chaining.
 */

/**
 * Adds a <b>one time</b> listener for the event. This listener is invoked only
 * the next time the event is fired, after which it is removed.
 * @function EventEmitter#once
 * @param {string} event The event to listen for.
 * @param {Function} listener The function to invoke.
 * @return {EventEmitter} for call chaining.
 */

/**
 * Remove a listener from the listener array for the specified event.
 * <b>Caution:</b> changes array indices in the listener array behind the
 * listener.
 * @function EventEmitter#removeListener
 * @param {string} event The event to listen for.
 * @param {Function} listener The function to invoke.
 * @return {EventEmitter} for call chaining.
 */

/**
 * Removes all listeners, or those of the specified event. It's not a good idea
 * to remove listeners that were added elsewhere in the code, especially when
 * it's on an emitter that you didn't create (e.g. sockets or file streams).
 * @function EventEmitter#removeAllListeners
 * @param {string} event Optional. The event to remove listeners for.
 * @return {EventEmitter} for call chaining.
 */

/**
 * Execute each of the listeners in order with the supplied arguments.
 * @function EventEmitter#emit
 * @param {string} event The event to emit.
 * @param {Function} listener The function to invoke.
 * @return {boolean} true if event had listeners, false otherwise.
 */

/**
 * By default EventEmitters will print a warning if more than 10 listeners are
 * added for a particular event. This is a useful default which helps finding
 * memory leaks. Obviously not all Emitters should be limited to 10. This
 * function allows that to be increased. Set to zero for unlimited.
 * @function EventEmitter#setMaxListeners
 * @param {Number} n The max number of listeners.
 * @return {EventEmitter} for call chaining.
 */

/**
 * @module imapflow
 */

// TODO:
// * Use buffers for compiled commands
// * OAuth2 authentication

const tls = require('tls');
const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const logger = require('./logger');
const libmime = require('libmime');
const zlib = require('zlib');
const { Headers } = require('mailsplit');

const { ImapStream } = require('./handler/imap-stream');
const { parser, compiler } = require('./handler/imap-handler');
const packageInfo = require('../package.json');

const libqp = require('libqp');
const libbase64 = require('libbase64');
const FlowedDecoder = require('mailsplit/lib/flowed-decoder');
const { PassThrough } = require('stream');

const { comparePaths, updateCapabilities, getFolderTree, formatMessageResponse, getDecoder, packMessageRange } = require('./tools');

const imapCommands = require('./imap-commands.js');

const CONNECT_TIMEOUT = 90 * 1000;
const GREETING_TIMEOUT = 16 * 1000;
const UPGRADE_TIMEOUT = 10 * 1000;

const states = {
    NOT_AUTHENTICATED: 0x01,
    AUTHENTICATED: 0x02,
    SELECTED: 0x03,
    LOGOUT: 0x04
};

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

/**
 * Connection close event
 *
 * @event module:imapflow~ImapFlow#close
 */

/**
 * Message count in currently opened mailbox changed
 *
 * @event module:imapflow~ImapFlow#exists
 * @type {object}
 * @property {string} path - mailbox path this event applies to
 * @property {number} count - updated count of messages
 * @property {number} prevCount - message count before this update
 * @example
 * client.on('exists', data=>{
 *     console.log(`Message count in "${data.path}" is ${data.count}`);
 * });
 */

/**
 * Deleted message sequence number in currently opened mailbox. One event is fired for every deleted email.
 *
 * @event module:imapflow~ImapFlow#expunge
 * @type {object}
 * @property {string} path - mailbox path this event applies to
 * @property {number} seq - sequence number of deleted message
 * @example
 * client.on('expunge', data=>{
 *     console.log(`Message #${data.seq} was deleted from "${data.path}"`);
 * });
 */

/**
 * Flags were updated for a message. Not all servers fire this event.
 *
 * @event module:imapflow~ImapFlow#flags
 * @type {object}
 * @property {string} path - mailbox path this event applies to
 * @property {number} seq - sequence number of updated message
 * @property {number} [uid] - UID number of updated message (if server provided this value)
 * @property {BigInt} [modseq] - Updated modseq number for the mailbox (if server provided this value)
 * @property {Set<string>} flags - A set of all flags for the updated message
 * @example
 * client.on('flags', data=>{
 *     console.log(`Flag set for #${data.seq} is now "${Array.from(data.flags).join(', ')}"`);
 * });
 */

/**
 * IMAP client class for accessing IMAP mailboxes
 *
 * @constructor
 * @extends EventEmitter
 */
class ImapFlow extends EventEmitter {
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
    constructor(options) {
        super();

        this.options = options || {};

        /**
         * Instance ID for logs
         * @type {String}
         */
        this.id = crypto.randomBytes(8).toString('hex');

        this.clientInfo = {
            name: packageInfo.name,
            version: packageInfo.version,
            vendor: 'Nodemailer',
            'support-url': 'https://github.com/nodemailer/nodemailer-app/issues'
        };

        /**
         * Server identification info
         * @type {Object}
         */
        this.serverInfo = null; //updated by ID

        this.log = this.options.logger || logger.child({ component: 'imap-connection', cid: this.id });

        /**
         * Is the connection currently encrypted or not
         * @type {Boolean}
         */
        this.secureConnection = !!this.options.secure;

        this.port = Number(this.options.port) || (this.secureConnection ? 993 : 110);
        this.host = this.options.host || 'localhost';
        this.servername = this.options.servername || this.host;

        if (typeof this.options.secure === 'undefined' && this.port === 993) {
            // if secure option is not set but port is 465, then default to secure
            this.secureConnection = true;
        }

        this.streamer = new ImapStream();
        this.reading = false;
        this.socket = false;
        this.writeSocket = false;

        this.states = states;
        this.state = this.states.NOT_AUTHENTICATED;

        this.tagCounter = 0;
        this.requestTagMap = new Map();
        this.requestQueue = [];
        this.currentRequest = false;

        this.commandParts = [];

        this.capabilities = new Map();
        this.expectCapabilityUpdate = false; // force CAPABILITY after LOGIN
        this.enabled = new Set();

        /**
         * Currently selected mailbox or *false* if mailbox is not open
         * @type {MailboxObject}
         */
        this.mailbox = false;

        this.untaggedHandlers = {};
        this.sectionHandlers = {};

        this.commands = imapCommands;

        this.folders = new Map();
    }

    write(chunk) {
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
        this.writeSocket.write(chunk);
    }

    async send(data) {
        if (this.state === this.states.LOGOUT) {
            // already logged out
            return;
        }

        let compiled = await compiler(data, {
            asArray: true,
            literalMinus: this.capabilities.has('LITERAL-') || this.capabilities.has('LITERAL+')
        });
        this.commandParts = compiled;

        let logCompiled = await compiler(data, {
            isLogging: true
        });

        this.log.info({ src: 's', msg: logCompiled.toString() });
        this.write(Buffer.from(this.commandParts.shift()));
    }

    async trySend() {
        if (this.currentRequest || !this.requestQueue.length) {
            return;
        }
        this.currentRequest = this.requestQueue.shift();
        await this.send({
            tag: this.currentRequest.tag,
            command: this.currentRequest.command,
            attributes: this.currentRequest.attributes
        });
    }

    async exec(command, attributes, options) {
        let tag = (++this.tagCounter).toString(16).toUpperCase();

        options = options || {};

        return new Promise((resolve, reject) => {
            this.requestTagMap.set(tag, { command, attributes, options, resolve, reject });
            this.requestQueue.push({ tag, command, attributes, options });
            this.trySend().catch(reject);
        });
    }

    getUntaggedHandler(command, attributes) {
        if (/^[0-9]+$/.test(command)) {
            let type = attributes && attributes.length && typeof attributes[0].value === 'string' ? attributes[0].value.toUpperCase() : false;
            if (type) {
                // EXISTS, EXPUNGE, RECENT, FETCH etc
                command = type;
            }
        }

        command = command.toUpperCase().trim();
        if (this.currentRequest && this.currentRequest.options && this.currentRequest.options.untagged && this.currentRequest.options.untagged[command]) {
            return this.currentRequest.options.untagged[command];
        }

        if (this.untaggedHandlers[command]) {
            return this.untaggedHandlers[command];
        }
    }

    getSectionHandler(key) {
        if (this.sectionHandlers[key]) {
            return this.sectionHandlers[key];
        }
    }

    async reader() {
        let data;
        while ((data = this.streamer.read()) !== null) {
            let parsed;

            try {
                parsed = await parser(data.payload, { literals: data.literals });
            } catch (err) {
                // can not make sense of this
                this.log.error({ src: 's', msg: data.payload.toString(), error: err.message });
                data.next();
                continue;
            }

            let logCompiled = await compiler(parsed, {
                isLogging: true
            });
            this.log.info({ src: 's', msg: logCompiled.toString() });

            if (parsed.tag === '+' && typeof this.onPlusTag === 'function') {
                await this.onPlusTag(data);
                data.next();
                continue;
            }

            if (parsed.tag === '+' && this.commandParts.length) {
                let content = Buffer.from(this.commandParts.shift());
                this.write(content);
                this.log.info({ src: 'c', msg: `(* ${content.length}B continuation *)` });
                data.next();
                continue;
            }

            let section = parsed.attributes && parsed.attributes.length && parsed.attributes[0] && !parsed.attributes[0].value && parsed.attributes[0].section;
            if (section && section.length && section[0].type === 'ATOM' && typeof section[0].value === 'string') {
                let sectionHandler = this.getSectionHandler(section[0].value.toUpperCase().trim());
                if (sectionHandler) {
                    await sectionHandler(section.slice(1));
                }
            }

            if (parsed.tag === '*' && parsed.command) {
                let untaggedHandler = this.getUntaggedHandler(parsed.command, parsed.attributes);
                if (untaggedHandler) {
                    try {
                        await untaggedHandler(parsed);
                    } catch (err) {
                        this.log.error(err);
                        data.next();
                        continue;
                    }
                }
            }

            if (this.requestTagMap.has(parsed.tag)) {
                let request = this.requestTagMap.get(parsed.tag);
                this.requestTagMap.delete(parsed.tag);

                if (this.currentRequest && this.currentRequest.tag === parsed.tag) {
                    // send next pending command
                    this.currentRequest = false;
                    await this.trySend();
                }

                switch (parsed.command.toUpperCase()) {
                    case 'OK':
                        await new Promise(resolve => request.resolve({ response: parsed, next: resolve }));
                        break;

                    case 'NO':
                    case 'BAD': {
                        let txt =
                            parsed.attributes &&
                            parsed.attributes
                                .filter(val => val.type === 'TEXT')
                                .map(val => val.value.trim())
                                .join(' ');
                        let err = new Error(txt || 'Command failed');
                        err.response = parsed;
                        request.reject(err);
                        break;
                    }

                    default: {
                        let err = new Error('Invalid server response');
                        err.response = parsed;
                        request.reject(err);
                        break;
                    }
                }
            }

            data.next();
        }
    }

    setEventHandlers() {
        this.socketReadable = () => {
            if (!this.reading) {
                this.reading = true;
                this.reader()
                    .catch(err => this.log.error(err))
                    .finally(() => {
                        this.reading = false;
                    });
            }
        };

        this.streamer.on('readable', this.socketReadable);
    }

    setSocketHandlers() {
        this._socketError =
            this._socketError ||
            (err => {
                this.close();
                this.emit('error', err);
            });
        this._socketClose =
            this._socketClose ||
            (() => {
                this.close();
            });
        this._socketEnd =
            this._socketEnd ||
            (() => {
                this.close();
            });
        this.socket.on('error', this._socketError);
        this.socket.on('close', this._socketClose);
        this.socket.on('end', this._socketEnd);
        this.socket.on('tlsClientError', this._socketError);
    }

    clearSocketHandlers() {
        if (this._socketError) {
            this.socket.removeListener('error', this._socketError);
            this.socket.removeListener('tlsClientError', this._socketError);
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
        await this.run('ID', this.clientInfo);

        // try to use STARTTLS is possible
        if (!this.secureConnection) {
            await this.upgradeConnection();
        }

        let authenticated = await this.authenticate();
        if (!authenticated) {
            // nothing to do here
            return await this.run('LOGOUT');
        }

        // try to use compression (if supported)
        if (!this.options.disableCompression) {
            await this.compress();
        }

        // make sure we have namespace set
        await this.run('NAMESPACE');

        // enable extensions if possible
        await this.run('ENABLE', ['CONDSTORE', 'UTF8=ACCEPT']);
    }

    async compress() {
        if (!(await this.run('COMPRESS'))) {
            return; // was not able to negotiate compression
        }

        // create deflate/inflate streams
        this._deflate = zlib.createDeflateRaw({
            windowBits: 15
        });
        this._inflate = zlib.createInflateRaw();

        // route incoming socket via inflate stream
        this.socket.unpipe(this.streamer);
        this.socket.pipe(this._inflate).pipe(this.streamer);
        this._inflate.on('error', err => {
            this.streamer.emit('error', err);
        });

        // route outgoing socket via deflate stream
        this.writeSocket = new PassThrough();

        // we need to force flush deflated data to socket so we can't
        // use normal pipes for this.writeSocket -> this._deflate -> this.socket
        let reading = false;
        let readNext = () => {
            reading = true;

            let chunk;
            while ((chunk = this.writeSocket.read()) !== null) {
                if (this._deflate && this._deflate.write(chunk) === false) {
                    return this._deflate.once('drain', readNext);
                }
            }

            // flush data to socket
            if (this._deflate) {
                this._deflate.flush();
            }

            reading = false;
        };

        this.writeSocket.on('readable', () => {
            if (!reading) {
                readNext();
            }
        });

        this._deflate.pipe(this.socket);
        this._deflate.on('error', err => {
            this.socket.emit('error', err);
        });
    }

    async upgradeConnection() {
        if (this.secureConnection) {
            // already secure
            return true;
        }

        if (!this.capabilities.has('STARTTLS')) {
            // can not upgrade
            return false;
        }

        this.expectCapabilityUpdate = true;
        let canUpgrade = await this.run('STARTTLS');
        if (!canUpgrade) {
            return;
        }

        this.socket.unpipe(this.streamer);
        let upgraded = await new Promise((resolve, reject) => {
            let socketPlain = this.socket;
            let opts = Object.assign(
                {
                    socket: this.socket,
                    servername: this.servername || this.host,
                    port: this.port,
                    minVersion: 'TLSv1'
                },
                this.options.tls || {}
            );
            this.clearSocketHandlers();

            socketPlain.once('error', err => {
                clearTimeout(this.connectTimeout);
                if (!this.upgrading) {
                    // don't care anymore
                    return;
                }
                this.close();
                this.upgrading = false;
                reject(err);
            });

            this.upgradeTimeout = setTimeout(() => {
                if (!this.upgrading) {
                    return;
                }
                this.close();
                let err = new Error('Failed to upgrade connection in required time');
                err.code = 'UPGRADE_TIMEOUT';
                reject(err);
            }, UPGRADE_TIMEOUT);

            this.upgrading = true;
            this.socket = tls.connect(opts, () => {
                clearTimeout(this.upgradeTimeout);
                if (this.closed) {
                    // not sure if this is possible?
                    return this.close();
                }

                this.secureConnection = true;
                this.upgrading = false;
                this.socket.pipe(this.streamer);
                this.tls = typeof this.socket.getCipher === 'function' ? this.socket.getCipher() : false;
                if (this.tls) {
                    this.tls.authorized = this.socket.authorized;
                }

                return resolve(true);
            });
            this.writeSocket = this.socket;

            this.setSocketHandlers();
        });

        if (upgraded && this.expectCapabilityUpdate) {
            await this.run('CAPABILITY');
        }

        return upgraded;
    }

    async setAuthenticationState() {
        this.state = this.states.AUTHENTICATED;
        if (this.expectCapabilityUpdate) {
            // update capabilities
            await this.run('CAPABILITY');
        }
    }

    async authenticate() {
        if (this.state !== this.states.NOT_AUTHENTICATED) {
            // nothing to do here, usually happens with PREAUTH greeting
            return this.state !== this.states.LOGOUT;
        }

        if (this.capabilities.has('LOGINDISABLED') || !this.options.auth) {
            // can not log in
            return false;
        }

        this.expectCapabilityUpdate = true;

        try {
            let authenticated = await this.run('LOGIN', this.options.auth.user, this.options.auth.pass);
            if (authenticated) {
                await this.setAuthenticationState();
                return true;
            }
        } catch (err) {
            await this.logout();
            this.close();
            throw err;
        }

        return false;
    }

    async initialOK() {
        clearTimeout(this.greetingTimeout);
        this.untaggedHandlers.OK = null;
        this.untaggedHandlers.PREAUTH = null;

        if (this.closed) {
            return;
        }

        // get out of current parsing "thread", so do not await for startSession
        this.startSession()
            .then(() => this.initialResolve())
            .catch(err => {
                this.log.error(err);
                this.close();
                this.initialReject(err);
            });
    }

    async initialPREAUTH() {
        clearTimeout(this.greetingTimeout);
        this.untaggedHandlers.OK = null;
        this.untaggedHandlers.PREAUTH = null;

        if (this.closed) {
            return;
        }

        this.state = this.states.AUTHENTICATED;

        // get out of current parsing "thread", so do not await for startSession
        this.startSession()
            .then(() => this.initialResolve())
            .catch(err => {
                this.log.error(err);
                this.close();
                this.initialReject(err);
            });
    }

    async serverBye() {
        this.untaggedHandlers.BYE = null;
        this.state = this.states.LOGOUT;
    }

    async sectionCapability(section) {
        this.capabilities = updateCapabilities(section);
        if (this.expectCapabilityUpdate) {
            this.expectCapabilityUpdate = false;
        }
    }

    async untaggedCapability(untagged) {
        this.capabilities = updateCapabilities(untagged.attributes);
        if (this.expectCapabilityUpdate) {
            this.expectCapabilityUpdate = false;
        }
    }

    async untaggedExists(untagged) {
        if (!this.mailbox) {
            // mailbox closed, ignore
            return;
        }

        if (!untagged || !untagged.command || isNaN(untagged.command)) {
            return;
        }

        let count = Number(untagged.command);
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

    async untaggedExpunge(untagged) {
        if (!this.mailbox) {
            // mailbox closed, ignore
            return;
        }

        if (!untagged || !untagged.command || isNaN(untagged.command)) {
            return;
        }

        let seq = Number(untagged.command);
        this.emit('expunge', {
            path: this.mailbox.path,
            seq
        });
    }

    async untaggedFetch(untagged) {
        if (!this.mailbox) {
            // mailbox closed, ignore
            return;
        }
        let message = await formatMessageResponse(untagged, this.mailbox);

        if (message.modseq && this.mailbox.highestModseq >= message.modseq) {
            // already seen
            return;
        }

        if (message.modseq && this.mailbox.highestModseq < message.modseq) {
            // bump known modseq value
            this.mailbox.highestModseq = message.modseq;
        }

        if (message.flags) {
            let updateEvent = {
                path: this.mailbox.path,
                seq: message.seq
            };

            if (message.uid) {
                updateEvent.uid = message.uid;
            }

            if (message.modseq) {
                updateEvent.modseq = message.modseq;
            }

            updateEvent.flags = message.flags;

            this.emit('flags', updateEvent);
        }
    }

    async ensureSelectedMailbox(path) {
        if (!path) {
            return false;
        }

        if ((!this.mailbox && path) || (this.mailbox && path && !comparePaths(this, this.mailbox.path, path))) {
            return await this.mailboxOpen(path);
        }

        return true;
    }

    async resolveRange(range, options) {
        if (typeof range === 'number' || typeof range === 'bigint') {
            range = range.toString();
        }

        if (range && typeof range === 'object') {
            if (range.all && Object.keys(range) === 1) {
                range = '1:*';
            } else if (range.uid && Object.keys(range) === 1) {
                range = range.uid;
                options.uid = true;
            } else {
                // resolve range by searching
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

    autoidle() {
        clearTimeout(this.idleStartTimer);
        if (this.options.disableAutoIdle || this.state !== this.states.SELECTED) {
            return;
        }
        this.idleStartTimer = setTimeout(() => {
            this.idle().catch(err => this.log.error(err));
        }, 15 * 1000);
    }

    // PUBLIC API METHODS

    /**
     * Initiates a connection against IMAP server. Throws if anything goes wrong. This is something you have to call before you can run any IMAP commands
     *
     * @example
     * let client = new ImapFlow({...});
     * await client.connect();
     */
    async connect() {
        let connector = this.options.secure ? tls : net;

        let opts = Object.assign(
            {
                host: this.host,
                servername: this.servername || this.host,
                port: this.port,
                minVersion: 'TLSv1'
            },
            this.options.tls || {}
        );

        this.untaggedHandlers.OK = (...args) => this.initialOK(...args);
        this.untaggedHandlers.BYE = (...args) => this.serverBye(...args);
        this.untaggedHandlers.PREAUTH = (...args) => this.initialPREAUTH(...args);

        this.untaggedHandlers.CAPABILITY = (...args) => this.untaggedCapability(...args);
        this.sectionHandlers.CAPABILITY = (...args) => this.sectionCapability(...args);

        this.untaggedHandlers.FETCH = (...args) => this.untaggedFetch(...args);
        this.untaggedHandlers.EXISTS = (...args) => this.untaggedExists(...args);
        this.untaggedHandlers.EXPUNGE = (...args) => this.untaggedExpunge(...args);

        await new Promise((resolve, reject) => {
            this.connectTimeout = setTimeout(() => {
                let err = new Error('Failed to established connection in required time');
                err.code = 'CONNECT_TIMEOUT';
                this.close();
                reject(err);
            }, CONNECT_TIMEOUT);

            this.socket = connector.connect(opts, () => {
                clearTimeout(this.connectTimeout);

                this.socket.setKeepAlive(true);

                this.greetingTimeout = setTimeout(() => {
                    let err = new Error('Failed to receive greeting from server in required time');
                    err.code = 'GREEETING_TIMEOUT';
                    this.close();
                    reject(err);
                }, GREETING_TIMEOUT);

                this.tls = typeof this.socket.getCipher === 'function' ? this.socket.getCipher() : false;
                if (this.tls) {
                    this.tls.authorized = this.socket.authorized;
                }

                this.setSocketHandlers();
                this.socket.pipe(this.streamer);

                // executed by initial "* OK"
                this.initialResolve = resolve;
                this.initialReject = reject;
            });
            this.writeSocket = this.socket;

            this.socket.once('error', err => {
                clearTimeout(this.connectTimeout);
                clearTimeout(this.greetingTimeout);
                this.close();
                reject(err);
            });

            this.setEventHandlers();
        });
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
    async logout() {
        await this.run('LOGOUT');
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
        if (typeof this.preCheck === 'function') {
            this.preCheck().catch(err => this.log.error(err));
        }

        this.state = this.states.LOGOUT;
        if (this.closed) {
            return;
        }
        this.closed = true;
        try {
            this.socket.end();
        } catch (err) {
            this.log.error(err);
        }
        this.emit('close');
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
    async getQuota(path) {
        path = path || 'INBOX';
        return await this.run('QUOTA', path);
    }

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

    /**
     * Lists available mailboxes as an Array
     *
     * @returns {ListResponse[]} - An array of ListResponse objects
     *
     * @example
     * let list = await client.list();
     * list.forEach(mailbox=>console.log(mailbox.path));
     */
    async list() {
        let folders = await this.run('LIST', '', '*');
        this.folders = new Map(folders.map(folder => [folder.path, folder]));
        return folders;
    }

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

    /**
     * Lists available mailboxes as a tree structured object
     *
     * @returns {ListTreeResponse} - Tree structured object
     *
     * @example
     * let tree = await client.listTree();
     * tree.folders.forEach(mailbox=>console.log(mailbox.path));
     */
    async listTree() {
        let folders = await this.run('LIST', '', '*');
        this.folders = new Map(folders.map(folder => [folder.path, folder]));
        return getFolderTree(folders);
    }

    /**
     * Performs a no-op call against server
     */
    async noop() {
        return await this.run('NOOP');
    }

    /**
     * @typedef {Object} MailboxCreateResponse
     * @property {string} path - full mailbox path
     * @property {string} [mailboxId] - unique mailbox ID if server supports OBJECTID extension (currently Yahoo and some others)
     */

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
    async mailboxCreate(path) {
        return await this.run('CREATE', path);
    }

    /**
     * @typedef {Object} MailboxRenameResponse
     * @property {string} path - full mailbox path that was renamed
     * @property {string} newPath - new full mailbox path
     */

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
    async mailboxRename(path, newPath) {
        return await this.run('RENAME', path, newPath);
    }

    /**
     * @typedef {Object} MailboxDeleteResponse
     * @property {string} path - full mailbox path that was deleted
     */

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
    async mailboxDelete(path) {
        return await this.run('DELETE', path);
    }

    /**
     * Subscribes to a mailbox
     *
     * @param {string|array} path - Path for the mailbox to subscribe to. Unicode is allowed. If value is an array then it is joined using current delimiter symbols. Namespace prefix is added automatically if required.
     * @returns {Boolean} - *true* if subscription operation succeeded, *false* otherwise
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
     * @param {string|array} path - **Path for the mailbox** to unsubscribe from. Unicode is allowed. If value is an array then it is joined using current delimiter symbols. Namespace prefix is added automatically if required.
     * @returns {Boolean} - *true* if unsubscription operation succeeded, *false* otherwise
     *
     * @example
     * await client.mailboxUnsubscribe('Important stuff ❗️');
     */
    async mailboxUnsubscribe(path) {
        return await this.run('UNSUBSCRIBE', path);
    }

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
    async mailboxOpen(path, options) {
        return await this.run('SELECT', path, options);
    }

    /**
     * Closes a previously opened mailbox
     *
     * @returns {Boolean} - Did the operation succeed or not
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
     * @property {string} path - full mailbox path that was checked
     * @property {number} [messages] - Count of messages
     * @property {number} [recent] - Count of messages with \\Recent tag
     * @property {number} [uidNext] - Predicted next UID
     * @property {BigInt} [uidValidity] - Mailbox UIDVALIDITY value
     * @property {number} [unseen] - Count of unseen messages
     * @property {BigInt} [highestModseq] - Last known modseq value (if CONDSTORE extension is enabled)
     */

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
    async status(path, query) {
        return await this.run('STATUS', path, query);
    }

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
    async idle() {
        return await this.run('IDLE');
    }

    /**
     * Sequence range string. Separate different values with commas, number ranges with colons and use \\* as the placeholder for the newest message in mailbox
     * @typedef {String} SequenceString
     * @example
     * "1:*" // for all messages
     * "1,2,3" // for messages 1, 2 and 3
     * "1,2,4:6" // for messages 1,2,4,5,6
     * "*" // for the newest message
     */

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
    async messageFlagsSet(range, flags, options) {
        options = options || {};
        let queryOpts = Object.assign(
            {
                operation: 'set'
            },
            options
        );

        range = await this.resolveRange(range, options);
        if (!range) {
            return false;
        }

        return await this.run('STORE', range, flags, queryOpts);
    }

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
    async messageFlagsAdd(range, flags, options) {
        options = options || {};
        let queryOpts = Object.assign(
            {
                operation: 'add'
            },
            options
        );

        range = await this.resolveRange(range, options);
        if (!range) {
            return false;
        }

        return await this.run('STORE', range, flags, queryOpts);
    }

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
    async messageFlagsRemove(range, flags, options) {
        options = options || {};
        let queryOpts = Object.assign(
            {
                operation: 'remove'
            },
            options
        );

        range = await this.resolveRange(range, options);
        if (!range) {
            return false;
        }

        return await this.run('STORE', range, flags, queryOpts);
    }

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
     * @property {string} path - full mailbox path where the message was uploaded to
     * @property {BigInt} [uidValidity] - mailbox UIDVALIDITY if server has UIDPLUS extension enabled
     * @property {number} [uid] - UID of the uploaded message if server has UIDPLUS extension enabled
     * @property {number} [seq] - sequence number of the uploaded message if path is currently selected mailbox
     */

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
    async append(path, content, flags, idate) {
        let response = await this.run('APPEND', path, content, flags, idate);

        if (!response) {
            return false;
        }

        return response;
    }

    /**
     * @typedef {Object} CopyResponseObject
     * @property {string} path - path of source mailbox
     * @property {string} destination - path of destination mailbox
     * @property {BigInt} [uidValidity] - destination mailbox UIDVALIDITY if server has UIDPLUS extension enabled
     * @property {Map<number, number>} [uidMap] - Map of UID values (if server has UIDPLUS extension enabled) where key is UID in source mailbox and value is the UID for the same message in destination mailbox
     */

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
    async messageMove(range, destination, options) {
        options = options || {};
        range = await this.resolveRange(range, options);
        if (!range) {
            return false;
        }
        return await this.run('MOVE', range, destination, options);
    }

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
    async search(query, options) {
        if (!this.mailbox) {
            // no mailbox selected, nothing to do
            return;
        }

        let response = await this.run('SEARCH', query, options);

        if (!response) {
            return false;
        }

        return response;
    }

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

    /**
     * Parsed email address entry
     *
     * @typedef {Object} MessageAddressObject
     * @property {string} [name] - name of the address object (unicode)
     * @property {string} [address] - email address
     */

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
    async *fetch(range, query, options) {
        options = options || {};
        try {
            if (!this.mailbox) {
                // no mailbox selected, nothing to do
                return;
            }

            range = await this.resolveRange(range, options);
            if (!range) {
                return false;
            }

            let finished = false;
            let push = false;
            let rowQueue = [];
            let getNext = () =>
                new Promise((resolve, reject) => {
                    let check = () => {
                        if (rowQueue.length) {
                            let entry = rowQueue.shift();
                            if (entry.err) {
                                return reject(entry.err);
                            } else {
                                return resolve(entry.value);
                            }
                        }
                        if (finished) {
                            return resolve(null);
                        }

                        // wait until data is pushed to queue and try again
                        push = () => {
                            push = false;
                            check();
                        };
                    };
                    check();
                });

            this.run('FETCH', range, query, {
                uid: !!options.uid,
                changedSince: options.changedSince,
                onUntaggedFetch: (untagged, next) => {
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
                });

            let res;
            while ((res = await getNext())) {
                if (res !== null) {
                    yield res.response;
                    res.next();
                }
            }
        } catch (err) {
            this.close();
            throw err;
        }
    }

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
    async fetchOne(seq, query, options) {
        if (!this.mailbox) {
            // no mailbox selected, nothing to do
            return;
        }

        let response = await this.run('FETCH', (seq || '').toString(), query, options);

        if (!response || !response.list || !response.list.length) {
            return false;
        }

        return response.list[0];
    }

    /**
     * @typedef {Object} DownloadObject
     * @property {Object} meta - content metadata
     * @property {string} meta.contentType - Content-Type of the streamed file. If part was not set then this value is "message/rfc822"
     * @property {string} [meta.charset] - Charset of the body part. Text parts are automaticaly converted to UTF-8, attachments are kept as is
     * @property {string} [meta.disposition] - Content-Disposition of the streamed file
     * @property {string} [meta.filename] - Filename of the streamed body part
     * @property {ReadableStream} content - Streamed content
     */

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
    async download(range, part, options) {
        if (!this.mailbox) {
            // no mailbox selected, nothing to do
            return {};
        }

        options = options || {};

        let hasMore = true;
        let processed = 0;
        let chunkSize = 64 * 1024;

        let uid = false;

        let getNextPart = async query => {
            query = query || {};

            let mimeKey;

            if (!part) {
                query.source = {
                    start: processed,
                    maxLength: chunkSize
                };
            } else {
                part = part
                    .toString()
                    .toLowerCase()
                    .trim();

                if (!query.bodyParts) {
                    query.bodyParts = [];
                }

                if (query.size && /^[\d.]+$/.test(part)) {
                    // fetch meta as well
                    mimeKey = part + '.mime';
                    query.bodyParts.push(mimeKey);
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

            let chunk = !part ? response.source : response.bodyParts.get(part);
            if (!chunk) {
                return {};
            }

            processed += chunk.length;
            hasMore = chunk.length >= chunkSize;

            let result = { chunk };
            if (query.size) {
                result.response = response;
            }

            if (mimeKey) {
                result.mime = response.bodyParts.get(mimeKey);
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
                meta.disposition = disposition.value.toLowerCase().trim() || false;
                try {
                    meta.disposition = libmime.decodeWords(meta.disposition);
                } catch (err) {
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
                    filename = this.libmime.decodeWords(filename);
                } catch (err) {
                    // failed to parse filename, keep as is (most probably an unknown charset is used)
                }
                meta.filename = filename;
            }
        }

        let stream;

        switch (meta.encoding) {
            case 'base64':
                stream = new libbase64.Decoder();
                break;
            case 'quoted-printable':
                stream = new libqp.Decoder();
                break;
            default:
                stream = new PassThrough();
        }

        let isTextNode = ['text/html', 'text/plain', 'text/x-amp-html'].includes(meta.contentType) || (part === '1' && !meta.contentType);
        if ((!meta.disposition || meta.disposition === 'inline') && isTextNode) {
            // flowed text
            if (meta.flowed) {
                let contentDecoder = stream;
                let flowDecoder = new FlowedDecoder({
                    delSp: meta.delSp
                });
                contentDecoder.on('error', err => {
                    flowDecoder.emit('error', err);
                });
                contentDecoder.pipe(flowDecoder);
                stream = flowDecoder;
            }

            // not utf-8 text
            if (meta.charset && !['ascii', 'usascii', 'utf8'].includes(meta.charset.toLowerCase().replace(/[^a-z0-9]+/g, ''))) {
                try {
                    let contentStream = stream;
                    stream = getDecoder(meta.charset);
                    contentStream.on('error', err => {
                        stream.emit('error', err);
                    });
                    contentStream.pipe(stream);
                    // force to utf-8 for output
                    meta.charset = 'utf-8';
                } catch (E) {
                    // do not decode charset
                }
            }
        }

        let fetchAllParts = async () => {
            while (hasMore) {
                let { chunk } = await getNextPart();
                if (!chunk) {
                    break;
                }

                if (stream.write(chunk) === false) {
                    await new Promise(resolve => stream.once('drain', resolve));
                }
            }
        };

        setImmediate(() => {
            stream.write(chunk);
            fetchAllParts()
                .catch(err => stream.emit('error', err))
                .finally(() => stream.end());
        });

        return {
            meta,
            content: stream
        };
    }

    async run(command, ...args) {
        command = command.toUpperCase();
        if (!this.commands.has(command)) {
            return false;
        }
        if (typeof this.preCheck === 'function') {
            await this.preCheck();
        }
        let handler = this.commands.get(command);
        let result = await handler(this, ...args);

        this.autoidle();

        return result;
    }
}

module.exports.ImapFlow = ImapFlow;
