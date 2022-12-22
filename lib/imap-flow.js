'use strict';

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
const { LimitedPassthrough } = require('./limited-passthrough');

const { ImapStream } = require('./handler/imap-stream');
const { parser, compiler } = require('./handler/imap-handler');
const packageInfo = require('../package.json');

const libqp = require('libqp');
const libbase64 = require('libbase64');
const FlowedDecoder = require('mailsplit/lib/flowed-decoder');
const { PassThrough } = require('stream');

const { proxyConnection } = require('./proxy-connection');

const { comparePaths, updateCapabilities, getFolderTree, formatMessageResponse, getDecoder, packMessageRange, normalizePath, expandRange } = require('./tools');

const imapCommands = require('./imap-commands.js');

const CONNECT_TIMEOUT = 90 * 1000;
const GREETING_TIMEOUT = 16 * 1000;
const UPGRADE_TIMEOUT = 10 * 1000;

const SOCKET_TIMEOUT = 5 * 60 * 1000;

const states = {
    NOT_AUTHENTICATED: 0x01,
    AUTHENTICATED: 0x02,
    SELECTED: 0x03,
    LOGOUT: 0x04
};

/**
 * @typedef {Object} MailboxObject
 * @global
 * @property {String} path mailbox path
 * @property {String} delimiter mailbox path delimiter, usually "." or "/"
 * @property {Set<string>} flags list of flags for this mailbox
 * @property {String} [specialUse] one of special-use flags (if applicable): "\All", "\Archive", "\Drafts", "\Flagged", "\Junk", "\Sent", "\Trash". Additionally INBOX has non-standard "\Inbox" flag set
 * @property {Boolean} listed `true` if mailbox was found from the output of LIST command
 * @property {Boolean} subscribed `true` if mailbox was found from the output of LSUB command
 * @property {Set<string>} permanentFlags A Set of flags available to use in this mailbox. If it is not set or includes special flag "\\\*" then any flag can be used.
 * @property {String} [mailboxId] unique mailbox ID if server has `OBJECTID` extension enabled
 * @property {BigInt} [highestModseq] latest known modseq value if server has CONDSTORE or XYMHIGHESTMODSEQ enabled
 * @property {String} [noModseq] if true then the server doesn't support the persistent storage of mod-sequences for the mailbox
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
     * @param {Object} options IMAP connection options
     * @param {String} options.host Hostname of the IMAP server
     * @param {Number} options.port Port number for the IMAP server
     * @param {Boolean} [options.secure=false] Should the connection be established over TLS.
     *      If `false` then connection is upgraded to TLS using STARTTLS extension before authentication
     * @param {String} [options.servername] Servername for SNI (or when host is set to an IP address)
     * @param {Boolean} [options.disableCompression=false] if `true` then client does not try to use COMPRESS=DEFLATE extension
     * @param {Object} options.auth Authentication options. Authentication is requested automatically during <code>connect()</code>
     * @param {String} options.auth.user Usename
     * @param {String} [options.auth.pass] Password, if using regular authentication
     * @param {String} [options.auth.accessToken] OAuth2 Access Token, if using OAuth2 authentication
     * @param {IdInfoObject} [options.clientInfo] Client identification info
     * @param {Boolean} [options.disableAutoIdle=false] if `true` then IDLE is not started automatically. Useful if you only need to perform specific tasks over the connection
     * @param {Object} [options.tls] Additional TLS options (see [Node.js TLS connect](https://nodejs.org/api/tls.html#tls_tls_connect_options_callback) for all available options)
     * @param {Boolean} [options.tls.rejectUnauthorized=true] if `false` then client accepts self-signed and expired certificates from the server
     * @param {String} [options.tls.minVersion=TLSv1] To improvde security you might need to use something newer, eg *'TLSv1.2'*
     * @param {Number} [options.tls.minDHSize=1024] Minimum size of the DH parameter in bits to accept a TLS connection
     * @param {Object} [options.logger] Custom logger instance with `debug(obj)`, `info(obj)`, `warn(obj)` and `error(obj)` methods. If not provided then ImapFlow logs to console using pino format
     * @param {Boolean} [options.logRaw=false] If true then log data read from and written to socket encoded in base64
     * @param {Boolean} [options.emitLogs=false] If `true` then in addition of sending data to logger, ImapFlow emits 'log' events with the same data
     * @param {Boolean} [options.verifyOnly=false] If `true` then logs out automatically after successful authentication
     * @param {String} [options.proxy] Optional proxy URL. Supports HTTP CONNECT (`http://`, `https://`) and SOCKS (`socks://`, `socks4://`, `socks5://`) proxies
     * @param {Boolean} [options.qresync=false] If true, then enables QRESYNC support. EXPUNGE notifications will include `uid` property instead of `seq`
     * @param {Number} [options.maxIdleTime] If set, then breaks and restarts IDLE every maxIdleTime ms
     * @param {Boolean} [options.disableBinary=false] If true, then ignores the BINARY extension when making FETCH and APPEND calls
     * @param {Boolean} [options.disableAutoEnable] Do not enable supported extensions by default
     * @param {Number} [options.connectionTimeout=90000] how many milliseconds to wait for the connection to establish (default is 90 seconds)
     * @param {Number} [options.greetingTimeout=16000] how many milliseconds to wait for the greeting after connection is established (default is 16 seconds)
     * @param {Number} [options.socketTimeout=300000] how many milliseconds of inactivity to allow (default is 5 minutes)
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

        this.port = Number(this.options.port) || (this.secureConnection ? 993 : 110);
        this.host = this.options.host || 'localhost';
        this.servername = this.options.servername ? this.options.servername : !net.isIP(this.host) ? this.host : false;

        if (typeof this.options.secure === 'undefined' && this.port === 993) {
            // if secure option is not set but port is 465, then default to secure
            this.secureConnection = true;
        }

        this.logRaw = this.options.logRaw;
        this.streamer = new ImapStream({
            logger: this.log,
            cid: this.id,
            logRaw: this.logRaw,
            secureConnection: this.secureConnection
        });

        this.reading = false;
        this.socket = false;
        this.writeSocket = false;

        this.states = states;
        this.state = this.states.NOT_AUTHENTICATED;

        this.lockCounter = 0;
        this.currentLockId = 0;

        this.tagCounter = 0;
        this.requestTagMap = new Map();
        this.requestQueue = [];
        this.currentRequest = false;

        this.writeBytesCounter = 0;

        this.commandParts = [];

        /**
         * Active IMAP capabilities. Value is either `true` for togglabe capabilities (eg. `UIDPLUS`)
         * or a number for capabilities with a value (eg. `APPENDLIMIT`)
         * @type {Map<string, boolean|number>}
         */
        this.capabilities = new Map();
        this.rawCapabilities = null;

        this.expectCapabilityUpdate = false; // force CAPABILITY after LOGIN

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

        /**
         * Is current mailbox idling (`true`) or not (`false`)
         * @type {Boolean}
         */
        this.idling = false;

        /**
         * If `true` then in addition of sending data to logger, ImapFlow emits 'log' events with the same data
         * @type {Boolean}
         */
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

        this.disableBinary = !!this.options.disableBinary;

        this.streamer.on('error', err => {
            if (['Z_BUF_ERROR', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH'].includes(err.code)) {
                // just close the connection, usually nothing but noise
                return setImmediate(() => this.close());
            }

            this.log.error({ err, cid: this.id });
            setImmediate(() => this.close());
            this.emitError(err);
        });
    }

    emitError(err) {
        this.emit('error', err);
    }

    getRandomId() {
        let rid = BigInt('0x' + crypto.randomBytes(13).toString('hex')).toString(36);
        if (rid.length < 20) {
            rid = '0'.repeat(20 - rid.length) + rid;
        } else if (rid.length > 20) {
            rid = rid.substr(0, 20);
        }
        return rid;
    }

    write(chunk) {
        if (this.socket.destroyed || this.state === this.states.LOGOUT) {
            // do not write after connection end or logout
            return;
        }

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
            this.log.trace({
                src: 'c',
                msg: 'write to socket',
                data: chunk.toString('base64'),
                compress: !!this._deflate,
                secure: !!this.secureConnection,
                cid: this.id
            });
        }

        this.writeBytesCounter += chunk.length;

        this.writeSocket.write(chunk);
    }

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

    async send(data) {
        if (this.state === this.states.LOGOUT) {
            // already logged out
            if (data.tag) {
                let request = this.requestTagMap.get(data.tag);
                if (request) {
                    this.requestTagMap.delete(request.tag);
                    request.reject(new Error('Connection not available'));
                }
            }
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

        let options = data.options || {};

        this.log.debug({ src: 's', msg: logCompiled.toString(), cid: this.id, comment: options.comment });
        this.write(this.commandParts.shift());

        if (typeof options.onSend === 'function') {
            options.onSend();
        }
    }

    async trySend() {
        if (this.currentRequest || !this.requestQueue.length) {
            return;
        }
        this.currentRequest = this.requestQueue.shift();

        await this.send({
            tag: this.currentRequest.tag,
            command: this.currentRequest.command,
            attributes: this.currentRequest.attributes,
            options: this.currentRequest.options
        });
    }

    async exec(command, attributes, options) {
        if (this.socket.destroyed) {
            throw new Error('Connection closed');
        }

        let tag = (++this.tagCounter).toString(16).toUpperCase();

        options = options || {};

        return new Promise((resolve, reject) => {
            this.requestTagMap.set(tag, { command, attributes, options, resolve, reject });
            this.requestQueue.push({ tag, command, attributes, options });
            this.trySend().catch(err => {
                this.requestTagMap.delete(tag);
                reject(err);
            });
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
                    this.emit('response', payload);
                }
            } catch (err) {
                // can not make sense of this
                this.log.error({ src: 's', msg: data.payload.toString(), err, cid: this.id });
                data.next();
                continue;
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

            if (parsed.tag === '+' && this.currentRequest && this.currentRequest.options && typeof this.currentRequest.options.onPlusTag === 'function') {
                await this.currentRequest.options.onPlusTag(parsed);
                data.next();
                continue;
            }

            if (parsed.tag === '+' && this.commandParts.length) {
                let content = this.commandParts.shift();
                this.write(content);
                this.log.debug({ src: 'c', msg: `(* ${content.length}B continuation *)`, cid: this.id });
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
                        this.log.warn({ err, cid: this.id });
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

                        let err = new Error('Command failed');
                        err.response = parsed;
                        err.responseStatus = parsed.command.toUpperCase();
                        if (txt) {
                            err.responseText = txt;
                        }
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
                    .catch(err => this.log.error({ err, cid: this.id }))
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
                this.log.error({ err, cid: this.id });
                setImmediate(() => this.close());
                this.emitError(err);
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

        this._socketTimeout =
            this._socketTimeout ||
            (() => {
                if (this.idling) {
                    this.run('NOOP')
                        .then(() => this.idle())
                        .catch(this._socketError);
                } else {
                    this.log.debug({ msg: 'Socket timeout', cid: this.id });
                    this.close();
                }
            });

        this.socket.on('error', this._socketError);
        this.socket.on('close', this._socketClose);
        this.socket.on('end', this._socketEnd);
        this.socket.on('tlsClientError', this._socketError);
        this.socket.on('timeout', this._socketTimeout);
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

        if (this.capabilities.has('ID')) {
            this.idRequested = await this.run('ID', this.clientInfo);
        }

        // try to use STARTTLS is possible
        if (!this.secureConnection) {
            await this.upgradeConnection();
        }

        let authenticated = await this.authenticate();
        if (!authenticated) {
            // nothing to do here
            return await this.logout();
        }

        if (!this.idRequested && this.capabilities.has('ID')) {
            // re-request ID after LOGIN
            this.idRequested = await this.run('ID', this.clientInfo);
        }

        // Make sure we have namespace set. This should also throw if Exchange actually failed authentication
        let nsResponse = await this.run('NAMESPACE');
        if (nsResponse && nsResponse.error && nsResponse.status === 'BAD' && /User is authenticated but not connected/i.test(nsResponse.text)) {
            // Not a NAMESPACE failure but authentication failure, so report as
            this.authenticated = false;
            let err = new Error('Authentication failed');
            err.authenticationFailed = true;
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
            // enable extensions if possible
            await this.run('ENABLE', ['CONDSTORE', 'UTF8=ACCEPT'].concat(this.options.qresync ? 'QRESYNC' : []));
        }

        this.usable = true;
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
        this.streamer.compress = true;
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
                    servername: this.servername,
                    port: this.port,
                    minVersion: 'TLSv1',
                    minDHSize: 1024
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
                setImmediate(() => this.close());
                this.upgrading = false;
                reject(err);
            });

            this.upgradeTimeout = setTimeout(() => {
                if (!this.upgrading) {
                    return;
                }
                setImmediate(() => this.close());
                let err = new Error('Failed to upgrade connection in required time');
                err.code = 'UPGRADE_TIMEOUT';
                reject(err);
            }, UPGRADE_TIMEOUT);

            this.upgrading = true;
            this.socket = tls.connect(opts, () => {
                clearTimeout(this.upgradeTimeout);
                if (this.isClosed) {
                    // not sure if this is possible?
                    return this.close();
                }

                this.secureConnection = true;
                this.upgrading = false;
                this.streamer.secureConnection = true;
                this.socket.pipe(this.streamer);
                this.tls = typeof this.socket.getCipher === 'function' ? this.socket.getCipher() : false;
                if (this.tls) {
                    this.tls.authorized = this.socket.authorized;
                    this.log.info({
                        src: 'tls',
                        msg: 'Established TLS session',
                        cid: this.id,
                        authorized: this.tls.authorized,
                        algo: this.tls.standardName || this.tls.name,
                        version: this.tls.version
                    });
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
        this.authenticated = true;
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

        if (this.options.auth.accessToken) {
            this.authenticated = await this.run('AUTHENTICATE', this.options.auth.user, this.options.auth.accessToken);
        } else if (this.options.auth.pass) {
            this.authenticated = await this.run('LOGIN', this.options.auth.user, this.options.auth.pass);
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

        return false;
    }

    async initialOK(message) {
        this.greeting = (message.attributes || [])
            .filter(entry => entry.type === 'TEXT')
            .map(entry => entry.value)
            .filter(entry => entry)
            .join('');

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
                    let reject = this.initialReject;
                    this.initialResolve = false;
                    this.initialReject = false;
                    return reject(err);
                }

                setImmediate(() => this.close());
            });
    }

    async initialPREAUTH() {
        clearTimeout(this.greetingTimeout);
        this.untaggedHandlers.OK = null;
        this.untaggedHandlers.PREAUTH = null;

        if (this.isClosed) {
            return;
        }

        this.state = this.states.AUTHENTICATED;

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
                    let reject = this.initialReject;
                    this.initialResolve = false;
                    this.initialReject = false;
                    return reject(err);
                }

                setImmediate(() => this.close());
            });
    }

    async serverBye() {
        this.untaggedHandlers.BYE = null;
        this.state = this.states.LOGOUT;
    }

    async sectionCapability(section) {
        this.rawCapabilities = section;
        this.capabilities = updateCapabilities(section);
        if (this.expectCapabilityUpdate) {
            this.expectCapabilityUpdate = false;
        }
    }

    async untaggedCapability(untagged) {
        this.rawCapabilities = untagged.attributes;
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
        if (seq && seq <= this.mailbox.exists) {
            this.mailbox.exists--;
            let payload = {
                path: this.mailbox.path,
                seq,
                vanished: false
            };

            if (typeof this.options.expungeHandler === 'function') {
                try {
                    await this.options.expungeHandler(payload);
                } catch (err) {
                    this.log.error({ msg: 'Failed to notify expunge event', payload, error: err, cid: this.id });
                }
            } else {
                this.emit('expunge', payload);
            }
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

        if (untagged.attributes.length > 1 && Array.isArray(untagged.attributes[0])) {
            tags = untagged.attributes[0].map(entry => (typeof entry.value === 'string' ? entry.value.toUpperCase() : false)).filter(value => value);
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

            if (typeof this.options.expungeHandler === 'function') {
                try {
                    await this.options.expungeHandler(payload);
                } catch (err) {
                    this.log.error({ msg: 'Failed to notify expunge event', payload, error: err, cid: this.id });
                }
            } else {
                this.emit('expunge', payload);
            }
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

        // special case, some servers allow this, some do not, so replace it with the last known EXISTS value
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
            this.idle().catch(err => this.log.warn({ err, cid: this.id }));
        }, 15 * 1000);
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
        let connector = this.secureConnection ? tls : net;

        let opts = Object.assign(
            {
                host: this.host,
                servername: this.servername,
                port: this.port,
                minVersion: 'TLSv1',
                minDHSize: 1024
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
                socket = await proxyConnection(this.log, this.options.proxy, this.host, this.port);
                if (!socket) {
                    throw new Error('Failed to setup proxy connection');
                }
            } catch (err) {
                let error = new Error('Failed to setup proxy connection');
                error.code = err.code || 'ProxyError';
                error._err = err;
                this.log.error({ error, cid: this.id });
                throw error;
            }
        }

        await new Promise((resolve, reject) => {
            this.connectTimeout = setTimeout(() => {
                let err = new Error('Failed to established connection in required time');
                err.code = 'CONNECT_TIMEOUT';
                err.details = {
                    connectionTimeout: this.options.connectionTimeout || CONNECT_TIMEOUT
                };
                this.log.error({ err, cid: this.id });
                setImmediate(() => this.close());
                reject(err);
            }, this.options.connectionTimeout || CONNECT_TIMEOUT);

            let onConnect = () => {
                clearTimeout(this.connectTimeout);
                this.socket.setKeepAlive(true, 5 * 1000);
                this.socket.setTimeout(this.options.socketTimeout || SOCKET_TIMEOUT);

                this.greetingTimeout = setTimeout(() => {
                    let err = new Error(`Failed to receive greeting from server in required time${!this.secureConnection ? '. Maybe should use TLS?' : ''}`);
                    err.code = 'GREEETING_TIMEOUT';
                    err.details = {
                        greetingTimeout: this.options.greetingTimeout || GREETING_TIMEOUT
                    };
                    this.log.error({ err, cid: this.id });
                    setImmediate(() => this.close());
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
                    logInfo.algo = this.tls.standardName || this.tls.name;
                    logInfo.version = this.tls.version;
                }

                this.log.info(logInfo);

                this.setSocketHandlers();
                this.socket.pipe(this.streamer);

                // executed by initial "* OK"
                this.initialResolve = resolve;
                this.initialReject = reject;
            };

            if (socket) {
                // socket is already establised via proxy
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

            this.socket.once('error', err => {
                clearTimeout(this.connectTimeout);
                clearTimeout(this.greetingTimeout);
                setImmediate(() => this.close());
                this.log.error({ err, cid: this.id });
                reject(err);
            });

            this.setEventHandlers();
        });
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
        // clear pending timers
        clearTimeout(this.idleStartTimer);
        clearTimeout(this.upgradeTimeout);
        clearTimeout(this.connectTimeout);

        this.usable = false;
        this.idling = false;

        if (typeof this.initialReject === 'function' && !this.options.verifyOnly) {
            let reject = this.initialReject;
            this.initialResolve = false;
            this.initialReject = false;
            let err = new Error('Unexpected close');
            err.code = `ClosedAfterConnect${this.secureConnection ? 'TLS' : 'Text'}`;
            reject(err);
        }

        if (typeof this.preCheck === 'function') {
            this.preCheck().catch(err => this.log.warn({ err, cid: this.id }));
        }

        // reject command that is currently processed
        if (this.currentRequest && this.requestTagMap.has(this.currentRequest.tag)) {
            let request = this.requestTagMap.get(this.currentRequest.tag);
            if (request) {
                this.requestTagMap.delete(request.tag);
                request.reject(new Error('Connection not available'));
            }
            this.currentRequest = false;
        }

        // reject all other pending commands
        while (this.requestQueue.length) {
            let req = this.requestQueue.shift();
            if (req && this.requestTagMap.has(req.tag)) {
                let request = this.requestTagMap.get(req.tag);
                if (request) {
                    this.requestTagMap.delete(request.tag);
                    request.reject(new Error('Connection not available'));
                }
            }
        }

        this.state = this.states.LOGOUT;
        if (this.isClosed) {
            return;
        }
        this.isClosed = true;

        if (this.writeSocket && !this.writeSocket.destroyed) {
            try {
                this.writeSocket.end();
            } catch (err) {
                this.log.error({ err, cid: this.id });
            }
        }

        if (this.socket && !this.socket.destroyed && this.writeSocket !== this.socket) {
            try {
                this.socket.end();
            } catch (err) {
                this.log.error({ err, cid: this.id });
            }
        }

        this.log.trace({ msg: 'Connection closed', cid: this.id });
        this.emit('close');
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
     * @returns {Promise<QuotaResponse|Boolean>} Quota information or `false` if QUTOA extension is not supported or requested path does not exist
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
     * @global
     * @property {String} path mailbox path (unicode string)
     * @property {String} pathAsListed mailbox path as listed in the LIST/LSUB response
     * @property {String} name mailbox name (last part of path after delimiter)
     * @property {String} delimiter mailbox path delimiter, usually "." or "/"
     * @property {Array<string>} parent An array of parent folder names. All names are in unicode
     * @property {String} parentPath Same as `parent`, but as a complete string path (unicode string)
     * @property {Set<string>} flags a set of flags for this mailbox
     * @property {String} specialUse one of special-use flags (if applicable): "\All", "\Archive", "\Drafts", "\Flagged", "\Junk", "\Sent", "\Trash". Additionally INBOX has non-standard "\Inbox" flag set
     * @property {Boolean} listed `true` if mailbox was found from the output of LIST command
     * @property {Boolean} subscribed `true` if mailbox was found from the output of LSUB command
     * @property {StatusObject} [status] If `statusQuery` was used, then this value includes the status response
     */

    /**
     * Lists available mailboxes as an Array
     *
     * @param {Object} [options] defines additional listing options
     * @param {Object} [options.statusQuery] request status items for every listed entry
     * @param {Boolean} [options.statusQuery.messages] if `true` request count of messages
     * @param {Boolean} [options.statusQuery.recent] if `true` request count of messages with \\Recent tag
     * @param {Boolean} [options.statusQuery.uidNext] if `true` request predicted next UID
     * @param {Boolean} [options.statusQuery.uidValidity] if `true` request mailbox `UIDVALIDITY` value
     * @param {Boolean} [options.statusQuery.unseen] if `true` request count of unseen messages
     * @param {Boolean} [options.statusQuery.highestModseq] if `true` request last known modseq value
     * @param {Object} [options.specialUseHints] set specific paths as special use folders, this would override special use flags provided from the server
     * @param {String} [options.specialUseHints.sent] Path to "Sent Mail" folder
     * @param {String} [options.specialUseHints.trash] Path to "Trash" folder
     * @param {String} [options.specialUseHints.junk] Path to "Junk Mail" folder
     * @param {String} [options.specialUseHints.drafts] Path to "Drafts" folder
     * @returns {Promise<ListResponse[]>} An array of ListResponse objects
     *
     * @example
     * let list = await client.list();
     * list.forEach(mailbox=>console.log(mailbox.path));
     */
    async list(options) {
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
     * @property {array} flags list of flags for this mailbox
     * @property {String} specialUse one of special-use flags (if applicable): "\All", "\Archive", "\Drafts", "\Flagged", "\Junk", "\Sent", "\Trash". Additionally INBOX has non-standard "\Inbox" flag set
     * @property {Boolean} listed `true` if mailbox was found from the output of LIST command
     * @property {Boolean} subscribed `true` if mailbox was found from the output of LSUB command
     * @property {Boolean} disabled If `true` then this mailbox can not be selected in the UI
     * @property {ListTreeResponse[]} folders An array of subfolders
     */

    /**
     * Lists available mailboxes as a tree structured object
     *
     * @returns {Promise<ListTreeResponse>} Tree structured object
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
     * @property {Object.<string, Boolean|String>} [header] Mathces messages with header key set if value is `true` (**NB!** not supported by all servers) or messages where header partially matches a string value
     * @property {SearchObject[]} [or] An array of 2 or more {@link SearchObject} objects. At least on of these must match
     */

    /**
     * Sets flags for a message or message range
     *
     * @param {SequenceString | Number[] | SearchObject} range Range to filter the messages
     * @param {string[]} Array of flags to set. Only flags that are permitted to set are used, other flags are ignored
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
     * @param {string[]} Array of flags to set. Only flags that are permitted to set are used, other flags are ignored
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
     * @param {string[]} Array of flags to remove. Only flags that are permitted to set are used, other flags are ignored
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
     * Delete messages from currently opened mailbox. Method does not indicate info about deleted messages,
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
     * @property {String} path full mailbox path where the message was uploaded to
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
        let response = await this.run('APPEND', path, content, flags, idate);

        if (!response) {
            return false;
        }

        return response;
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
     * Search messages from currently opened mailbox
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

        let response = await this.run('SEARCH', query, options);

        if (!response) {
            return false;
        }

        return response;
    }

    /**
     * @typedef {Object} FetchQueryObject
     * @global
     * @property {Boolean} [uid] if `true` then include UID in the response
     * @property {Boolean} [flags] if `true` then include flags Set in the response
     * @property {Boolean} [bodyStructure] if `true` then include parsed BODYSTRUCTURE object in the response
     * @property {Boolean} [envelope] if `true` then include parsed ENVELOPE object in the response
     * @property {Boolean} [internalDate] if `true` then include internal date value in the response
     * @property {Boolean} [size] if `true` then include message size in the response
     * @property {boolean | Object} [source] if `true` then include full message in the response
     * @property {Number} [source.start] include full message in the response starting from *start* byte
     * @property {Number} [source.maxLength] include full message in the response, up to *maxLength* bytes
     * @property {String} [threadId] if `true` then include thread ID in the response (only if server supports either `OBJECTID` or `X-GM-EXT-1` extensions)
     * @property {Boolean} [labels] if `true` then include GMail labels in the response (only if server supports `X-GM-EXT-1` extension)
     * @property {boolean | string[]} [headers] if `true` then includes full headers of the message in the response. If the value is an array of header keys then includes only headers listed in the array
     * @property {string[]} [bodyParts] An array of BODYPART identifiers to include in the response
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
     * @property {Object} [dispositionParameters] Additional parameters for Conent-Disposition
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
     * @property {String} [threadid] unique thread ID. Only present if server supports `OBJECTID` or `X-GM-EXT-1` extension
     * @property {Set<string>} [labels] a Set of labels. Only present if server supports `X-GM-EXT-1` extension
     * @property {Number} [size] message size
     * @property {Set<string>} [flags] a set of message flags
     * @property {MessageEnvelopeObject} [envelope] message envelope
     * @property {MessageStructureObject} [bodyStructure] message body structure
     * @property {Date} [internalDate] message internal date
     * @property {Map<string, Buffer>} [bodyParts] a Map of message body parts where key is requested part identifier and value is a Buffer
     * @property {Buffer} [headers] Requested header lines as Buffer
     */

    /**
     * Fetch messages from currently opened mailbox
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
                binary: options.binary,
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
            setImmediate(() => this.close());
            throw err;
        }
    }

    /**
     * Fetch a single message from currently opened mailbox
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
     * // fetch UID for all messages in a mailbox
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
     * @property {String} [meta.charset] Charset of the body part. Text parts are automaticaly converted to UTF-8, attachments are kept as is
     * @property {String} [meta.disposition] Content-Disposition of the streamed file
     * @property {String} [meta.filename] Filename of the streamed body part
     * @property {ReadableStream} content Streamed content
     */

    /**
     * Download either full rfc822 formated message or a specific bodystructure part as a Stream.
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
        let maxBytes = Number(options.maxBytes) || Infinity;

        let uid = false;

        if (part === '1') {
            // First part has special conditions for single node emails as
            // the mime parts for root node are not 1 and 1.MIME but TEXT and HEADERS
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
        let output;

        switch (meta.encoding) {
            case 'base64':
                output = stream = new libbase64.Decoder();
                break;
            case 'quoted-printable':
                output = stream = new libqp.Decoder();
                break;
            default:
                output = stream = new PassThrough();
        }

        let isTextNode = ['text/html', 'text/plain', 'text/x-amp-html'].includes(meta.contentType) || (part === '1' && !meta.contentType);
        if ((!meta.disposition || meta.disposition === 'inline') && isTextNode) {
            // flowed text
            if (meta.flowed) {
                let flowDecoder = new FlowedDecoder({
                    delSp: meta.delSp
                });
                output.on('error', err => {
                    flowDecoder.emit('error', err);
                });
                output = output.pipe(flowDecoder);
            }

            // not utf-8 text
            if (meta.charset && !['ascii', 'usascii', 'utf8'].includes(meta.charset.toLowerCase().replace(/[^a-z0-9]+/g, ''))) {
                try {
                    let decoder = getDecoder(meta.charset);
                    output.on('error', err => {
                        decoder.emit('error', err);
                    });
                    output = output.pipe(decoder);
                    // force to utf-8 for output
                    meta.charset = 'utf-8';
                } catch (E) {
                    // do not decode charset
                }
            }
        }

        let limiter = new LimitedPassthrough({ maxBytes });
        output.on('error', err => {
            limiter.emit('error', err);
        });
        output = output.pipe(limiter);

        let writeChunk = chunk => {
            if (limiter.limited) {
                return true;
            }
            return stream.write(chunk);
        };

        let fetchAllParts = async () => {
            while (hasMore && !limiter.limited) {
                let { chunk } = await getNextPart();
                if (!chunk) {
                    break;
                }

                if (writeChunk(chunk) === false) {
                    await new Promise(resolve => stream.once('drain', resolve));
                }
            }
        };

        setImmediate(() => {
            writeChunk(chunk);
            fetchAllParts()
                .catch(err => stream.emit('error', err))
                .finally(() => stream.end());
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
     * @param {String} parts A list of bodystructure parts
     * @param {Object} [options]
     * @param {Boolean} [options.uid] If `true` then uses UID number instead of sequence number for `range`
     * @returns {Promise<Object>} Download data object
     *
     * @example
     * let mailbox = await client.mailboxOpen('INBOX');
     * // download body part nr '1.2' from latest message
     * let response = await client.downloadMany('*', ['2', '3]);
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
            let keyParts = part.split('.');
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
                    data[key].meta.disposition = disposition.value.toLowerCase().trim() || false;
                    try {
                        data[key].meta.disposition = libmime.decodeWords(data[key].meta.disposition);
                    } catch (err) {
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
                        filename = this.libmime.decodeWords(filename);
                    } catch (err) {
                        // failed to parse filename, keep as is (most probably an unknown charset is used)
                    }
                    data[key].meta.filename = filename;
                }
            }
        }

        for (let part of Object.keys(data)) {
            let meta = data[part].meta;

            switch (meta.encoding) {
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

        if (this.socket.destroyed) {
            let err = new Error('Connection not available');
            throw err;
        }

        clearTimeout(this.idleStartTimer);

        if (typeof this.preCheck === 'function') {
            await this.preCheck();
        }

        let handler = this.commands.get(command);

        let result = await handler(this, ...args);

        this.autoidle();

        return result;
    }

    async processLocks(force) {
        if (!force && this.processingLock) {
            return;
        }
        if (!this.locks.length) {
            this.processingLock = false;
            return;
        }
        this.processingLock = true;

        const release = () => {
            if (this.currentLockId) {
                this.log.trace({ msg: 'Mailbox lock released', lockId: this.currentLockId, path: this.mailbox && this.mailbox.path });
                this.currentLockId = 0;
            }
            this.processLocks(true).catch(err => this.log.error({ err, cid: this.id }));
        };

        const { resolve, reject, path, options, lockId } = this.locks.shift();

        if (!this.usable || this.socket.destroyed) {
            // reject all
            let err = new Error('Connection not available');
            this.log.trace({ msg: 'Failed to acquire mailbox lock', path, lockId });
            reject(err);
            return await this.processLocks(true);
        }

        if (this.mailbox && this.mailbox.path === path && !!this.mailbox.readOnly === !!options.readOnly) {
            // nothing to do here, already selected
            this.log.trace({ msg: 'Mailbox lock acquired', path, lockId });
            this.currentLockId = lockId;
            return resolve({ path, release });
        } else {
            try {
                // Try to open. Throws if mailbox does not exists or can't open
                await this.mailboxOpen(path, options);
                this.log.trace({ msg: 'Lock acquired', path, lockId });
                this.currentLockId = lockId;
                return resolve({ path, release });
            } catch (err) {
                if (err.responseStatus === 'NO') {
                    try {
                        let folders = await this.run('LIST', '', path, { listOnly: true });
                        if (!folders || !folders.length) {
                            err.mailboxMissing = true;
                        }
                    } catch (E) {
                        this.log.trace({ msg: 'Failed to verify failed mailbox', path, err: E });
                    }
                }

                this.log.trace({ msg: 'Failed to acquire mailbox lock', path, lockId });
                reject(err);
                await this.processLocks(true);
            }
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
    async getMailboxLock(path, options) {
        options = options || {};

        path = normalizePath(this, path);

        let lockId = ++this.lockCounter;
        this.log.trace({ msg: 'Requesting lock', path, lockId });

        return await new Promise((resolve, reject) => {
            this.locks.push({ resolve, reject, path, options, lockId });
            this.processLocks().catch(err => reject(err));
        });
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
                    if (logger)
                        if (typeof mainLogger[level] !== 'function') {
                            // we are checking to make sure the level is supported.
                            // if it isn't supported but the level is error or fatal, log to console anyway.
                            if (level === 'fatal' || level === 'error') {
                                console.log(JSON.stringify(...args));
                            }
                        } else {
                            mainLogger[level](...args);
                        }
                }

                if (this.emitLogs && args && args[0] && typeof args[0] === 'object') {
                    let logEntry = Object.assign({ level, t: Date.now(), cid: this.id, lo: ++this.lo }, args[0]);
                    if (logEntry.err && typeof logEntry.err === 'object') {
                        let err = logEntry.err;
                        logEntry.err = {
                            stack: err.stack
                        };
                        // enumerable error fields
                        Object.keys(err).forEach(key => {
                            logEntry.err[key] = err[key];
                        });
                    }
                    this.emit('log', logEntry);
                }
            };
        }

        return synteticLogger;
    }

    unbind() {
        this.socket.unpipe(this.streamer);
        if (this._inflate) {
            this._inflate.unpipe(this.streamer);
        }

        this.socket.removeListener('error', this._socketError);
        this.socket.removeListener('close', this._socketClose);
        this.socket.removeListener('end', this._socketEnd);
        this.socket.removeListener('tlsClientError', this._socketError);
        this.socket.removeListener('timeout', this._socketTimeout);

        return {
            readSocket: this._inflate || this.socket,
            writeSocket: this.writeSocket || this.socket
        };
    }
}

/**
 * Connection close event. **NB!** ImapFlow does not handle reconncts automatically.
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
 *     console.log(`${log.cid} ${log.msg}`);
 * });
 */

module.exports.ImapFlow = ImapFlow;
