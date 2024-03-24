/**
 * @module imapflow
 */

// TODO:
// * Use buffers for compiled commands
// * OAuth2 authentication

import tls = require('tls');
import net = require('net');
import crypto = require('crypto');
import { EventEmitter } from 'events';
import logger = require('./logger');
import libmime = require('libmime');
import zlib = require('zlib');
import { Headers } from 'mailsplit';
import { LimitedPassthrough } from './limited-passthrough';
import { ImapStream } from './handler/imap-stream';
import { parser, compiler } from './handler/imap-handler';
import packageInfo = require('../package.json');
import libqp = require('libqp');
import libbase64 = require('libbase64');
import FlowedDecoder = require('mailsplit/lib/flowed-decoder');
import { PassThrough } from 'stream';
import { proxyConnection } from './proxy-connection';
import * as imapCommands from './imap-commands.js';
import { StrictEventEmitter } from 'strict-event-emitter-types';

import {
    comparePaths,
    updateCapabilities,
    getFolderTree,
    formatMessageResponse,
    getDecoder,
    packMessageRange,
    normalizePath,
    expandRange,
    getColorFlags
} from './tools';
import {
    AppendResponseObject,
    MessageOptions,
    CopyResponseObject,
    IdInfoObject,
    ListOptions,
    ListResponse,
    ListTreeResponse,
    MailboxCreateResponse,
    MailboxDeleteResponse,
    MailboxObject,
    MailboxOpenOptions,
    MailboxRenameResponse,
    MessageFlagsOptions,
    QuotaResponse,
    SearchObject,
    SequenceString,
    StatusObject,
    StatusQuery,
    FetchQueryObject,
    FetchOptions,
    FetchMessageObject,
    DownloadOptions,
    DownloadObject,
    Options,
    MailboxLockObject
} from './types';

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
 * IMAP client class for accessing IMAP mailboxes
 */
export class ImapFlow {
    /**
     * Current module version as a static class property
     * @property {String} version Module version
     * @static
     */
    static version = packageInfo.version;

    /**
     * Currently authenticated user or `false` if mailbox is not open
     * or `true` if connection was authenticated by PREAUTH
     */
    authenticated: string | boolean = false;
    /**
     * Active IMAP capabilities. Value is either `true` for togglabe capabilities (eg. `UIDPLUS`)
     * or a number for capabilities with a value (eg. `APPENDLIMIT`)
     */
    capabilities = new Map<string, boolean | number>();
    /**
     * If `true` then in addition of sending data to logger, ImapFlow emits 'log' events with the same data.
     */
    emitLogs: boolean;
    /**
     * Enabled capabilities. Usually `CONDSTORE` and `UTF8=ACCEPT` if server supports these.
     *
     */
    enabled = new Set<string>();
    /**
     * Instance ID for logs
     */
    id: string;
    /**
     * Is the current mailbox idling or not
     */
    idling: boolean = false;
    /**
     * Currently selected mailbox or `false` if mailbox is not open
     */
    mailbox: MailboxObject | false = false;
    /**
     * Is the connection currently encrypted or not
     */
    secureConnection: boolean;
    /**
     * Server identification info. Available after successful `connect()`.
     * If server does not provide identification info then this value is `null`.
     * @example
     * await client.connect();
     * console.log(client.serverInfo.vendor);
     */
    serverInfo: IdInfoObject | null = null;
    /**
     * Is the connection currently usable or not
     */
    usable: boolean = false;

    protected authCapabilities = new Map<string, boolean | number>();
    protected clientInfo: IdInfoObject;
    protected commandParts: any[] = [];
    protected commands: Map<string, any> = new Map(Object.entries(imapCommands));
    protected connectTimeout: NodeJS.Timeout;
    protected currentLock: any = false;
    protected currentRequest: any = false;
    protected currentSelectCommand: any = false;
    protected disableBinary: boolean;
    /** Force CAPABILITY after LOGIN */
    protected expectCapabilityUpdate: boolean = false;
    protected folders = new Map<any, any>();
    protected greeting: string;
    protected greetingTimeout: NodeJS.Timeout;
    protected host: string;
    protected idRequested: boolean = false;
    protected idleStartTimer: NodeJS.Timeout;
    protected initialResolve: any;
    protected initialReject: any;
    protected isClosed: boolean;
    /** Ordering number for emitted logs */
    protected lo: number = 0;
    protected lockCounter: number = 0;
    protected locks: any[] = [];
    protected log: any;
    protected logRaw: boolean;
    protected maxIdleTime: number | false;
    protected missingIdleCommand: string;
    protected port: number;
    protected preCheck: () => Promise<void>;
    protected processingLock: boolean;
    protected rawCapabilities: any = null;
    protected reading: boolean = false;
    protected requestQueue: any[] = [];
    protected requestTagMap = new Map<any, any>();
    protected sectionHandlers: any = {};
    protected servername: string | false;
    protected socket: net.Socket | tls.TLSSocket = null!;
    protected state: number = states.NOT_AUTHENTICATED;
    protected states = states;
    protected streamer: ImapStream;
    protected tagCounter: number = 0;
    protected tls: (tls.CipherNameAndProtocol & { authorized?: boolean }) | false;
    protected untaggedHandlers: any = {};
    protected upgradeTimeout: NodeJS.Timeout;
    protected upgrading: boolean;
    protected writeBytesCounter: number = 0;
    protected writeSocket: net.Socket | tls.TLSSocket = null!;

    /** Underscore variables in alphabetical order. */
    private _deflate: zlib.DeflateRaw | null;
    private _inflate: zlib.InflateRaw | null;
    private _mailboxList: any;
    private _socketClose: () => void;
    private _socketEnd: () => void;
    private _socketError: (err: any) => void;
    private _socketReadable: () => void;
    private _socketTimeout: () => void;

    constructor(public options: Options = {}) {
        // Initialize the EventEmitter internals the old-fashioned way, since we
        // are using StrictEventEmitter for public-facing types.
        EventEmitter.call(this, { captureRejections: true });

        this.id = options.id || this.getRandomId();

        this.clientInfo = {
            name: packageInfo.name,
            version: packageInfo.version,
            vendor: 'Postal Systems',
            'support-url': 'https://github.com/postalsys/imapflow/issues',
            ...options.clientInfo
        };

        this.log = this.getLogger();

        /**
         * Is the connection currently encrypted or not
         * @type {Boolean}
         */
        this.secureConnection = !!options.secure;

        this.port = Number(options.port) || (this.secureConnection ? 993 : 110);
        this.host = options.host || 'localhost';
        this.servername = options.servername ? options.servername : !net.isIP(this.host) ? this.host : false;

        if (typeof options.secure === 'undefined' && this.port === 993) {
            // if secure option is not set but port is 993, then default to secure
            this.secureConnection = true;
        }

        this.logRaw = !!options.logRaw;
        this.streamer = new ImapStream({
            logger: this.log,
            cid: this.id,
            logRaw: this.logRaw,
            secureConnection: this.secureConnection
        });

        this.emitLogs = !!options.emitLogs;

        this.maxIdleTime = options.maxIdleTime || false;
        this.missingIdleCommand = (options.missingIdleCommand || '').toString().toUpperCase().trim() || 'NOOP';

        this.disableBinary = !!options.disableBinary;

        this.streamer.on('error', (err: any) => {
            if (['Z_BUF_ERROR', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH'].includes(err.code)) {
                // just close the connection, usually nothing but noise
                return setImmediate(() => this.close());
            }

            this.log.error({ err, cid: this.id });
            setImmediate(() => this.close());
            this.emitError(err);
        });
    }

    protected emitError(err) {
        this.emit('error', err);
    }

    protected getRandomId() {
        let rid = BigInt('0x' + crypto.randomBytes(13).toString('hex')).toString(36);
        if (rid.length < 20) {
            rid = '0'.repeat(20 - rid.length) + rid;
        } else if (rid.length > 20) {
            rid = rid.substr(0, 20);
        }
        return rid;
    }

    protected write(chunk) {
        if (this.socket.destroyed || this.state === this.states.LOGOUT) {
            // do not write after connection end or logout
            return;
        }

        if (this.writeSocket.destroyed) {
            this.socket.emit('error', 'Write socket destroyed');
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

    protected stats(reset) {
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

    protected async send(data) {
        if (this.state === this.states.LOGOUT) {
            // already logged out
            if (data.tag) {
                let request = this.requestTagMap.get(data.tag);
                if (request) {
                    this.requestTagMap.delete(request.tag);
                    const error: any = new Error('Connection not available');
                    error.code = 'NoConnection';
                    request.reject(error);
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

    protected async trySend() {
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

    protected async exec(command, attributes, options = {}) {
        if (this.socket.destroyed) {
            let error: any = new Error('Connection closed');
            error.code = 'EConnectionClosed';
            throw error;
        }

        let tag = (++this.tagCounter).toString(16).toUpperCase();

        return new Promise((resolve, reject) => {
            this.requestTagMap.set(tag, { command, attributes, options, resolve, reject });
            this.requestQueue.push({ tag, command, attributes, options });
            this.trySend().catch(err => {
                this.requestTagMap.delete(tag);
                reject(err);
            });
        });
    }

    protected getUntaggedHandler(command, attributes) {
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

    protected getSectionHandler(key) {
        if (this.sectionHandlers[key]) {
            return this.sectionHandlers[key];
        }
    }

    protected async reader() {
        let data;
        while ((data = this.streamer.read()) !== null) {
            let parsed;

            try {
                parsed = await parser(data.payload, { literals: data.literals });
                if (parsed.tag && !['*', '+'].includes(parsed.tag) && parsed.command) {
                    let payload: any = { response: parsed.command };

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
                    case 'BYE':
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

                        let err: any = new Error('Command failed');
                        err.response = parsed;
                        err.responseStatus = parsed.command.toUpperCase();
                        if (txt) {
                            err.responseText = txt;

                            let throttleDelay: number | false = false;

                            // MS365 throttling
                            // tag BAD Request is throttled. Suggested Backoff Time: 92415 milliseconds
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

                                let delayResponse = throttleDelay;
                                if (delayResponse > 5 * 60 * 1000) {
                                    // max delay cap
                                    delayResponse = 5 * 60 * 1000;
                                }

                                this.log.warn({ msg: 'Throttling detected', err, cid: this.id, throttleDelay, delayResponse });
                                await new Promise(r => setTimeout(r, delayResponse));
                            }
                        }

                        request.reject(err);
                        break;
                    }

                    default: {
                        let err: any = new Error('Invalid server response');
                        err.code = 'InvalidResponse';
                        err.response = parsed;
                        request.reject(err);
                        break;
                    }
                }
            }

            data.next();
        }
    }

    protected setEventHandlers() {
        this._socketReadable = () => {
            if (!this.reading) {
                this.reading = true;
                this.reader()
                    .catch(err => this.log.error({ err, cid: this.id }))
                    .finally(() => {
                        this.reading = false;
                    });
            }
        };

        this.streamer.on('readable', this._socketReadable);
    }

    protected setSocketHandlers() {
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

        this.writeSocket.on('error', this._socketError);
    }

    protected clearSocketHandlers() {
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

    protected async startSession() {
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
            let err: any = new Error('Authentication failed');
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

    protected async compress() {
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
        this.writeSocket = new PassThrough() as any;

        this.writeSocket.destroySoon = () => {
            try {
                if (this.socket) {
                    this.socket.destroySoon();
                }
                this.writeSocket.end();
            } catch (err) {
                this.log.error({ err, info: 'Failed to destroy PassThrough socket', cid: this.id });
                throw err;
            }
        };

        Object.defineProperty(this.writeSocket, 'destroyed', {
            get: () => this.socket.destroyed
        });

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
        this.writeSocket.on('error', err => {
            this.socket.emit('error', err);
        });

        this._deflate.pipe(this.socket);
        this._deflate.on('error', err => {
            this.socket.emit('error', err);
        });
    }

    protected async upgradeConnection() {
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
            let opts: any = {
                socket: this.socket,
                servername: this.servername,
                port: this.port,
                ...this.options.tls
            };
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
                let err: any = new Error('Failed to upgrade connection in required time');
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
                this.tls = this.socket instanceof tls.TLSSocket ? this.socket.getCipher() : false;
                if (this.tls) {
                    this.tls.authorized = (this.socket as any).authorized;
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

    protected async setAuthenticationState() {
        this.state = this.states.AUTHENTICATED;
        this.authenticated = true;
        if (this.expectCapabilityUpdate) {
            // update capabilities
            await this.run('CAPABILITY');
        }
    }

    protected async authenticate() {
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

    protected async initialOK(message) {
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
                    clearTimeout(this.greetingTimeout);
                    let reject = this.initialReject;
                    this.initialResolve = false;
                    this.initialReject = false;
                    return reject(err);
                }

                setImmediate(() => this.close());
            });
    }

    protected async initialPREAUTH() {
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
                    clearTimeout(this.greetingTimeout);
                    let reject = this.initialReject;
                    this.initialResolve = false;
                    this.initialReject = false;
                    return reject(err);
                }

                setImmediate(() => this.close());
            });
    }

    protected async serverBye() {
        this.untaggedHandlers.BYE = null;
        this.state = this.states.LOGOUT;
    }

    protected async sectionCapability(section) {
        this.rawCapabilities = section;
        this.capabilities = updateCapabilities(section);

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

    protected async untaggedCapability(untagged) {
        this.rawCapabilities = untagged.attributes;
        this.capabilities = updateCapabilities(untagged.attributes);

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

    protected async untaggedExists(untagged) {
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

    protected async untaggedExpunge(untagged) {
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

    protected async untaggedVanished(untagged, mailbox = this.mailbox) {
        if (!mailbox) {
            // mailbox closed, ignore
            return;
        }

        let tags: string[] = [];
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
            let payload: any = {
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

    protected async untaggedFetch(untagged, mailbox = this.mailbox) {
        if (!mailbox) {
            // mailbox closed, ignore
            return;
        }

        let message = await formatMessageResponse(untagged, mailbox);
        if (message.flags) {
            let updateEvent: any = {
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

    protected async ensureSelectedMailbox(path) {
        if (!path) {
            return false;
        }

        if ((!this.mailbox && path) || (this.mailbox && path && !comparePaths(this, this.mailbox.path, path))) {
            return await this.mailboxOpen(path);
        }

        return true;
    }

    protected async resolveRange(range, options) {
        if (typeof range === 'number' || typeof range === 'bigint') {
            range = range.toString();
        }

        // special case, some servers allow this, some do not, so replace it with the last known EXISTS value
        if (range === '*') {
            const mailbox = this.mailbox as MailboxObject;
            if (!mailbox.exists) {
                return false;
            }
            range = mailbox.exists.toString();
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

    protected autoidle() {
        clearTimeout(this.idleStartTimer);
        if (this.options.disableAutoIdle || this.state !== this.states.SELECTED) {
            return;
        }
        this.idleStartTimer = setTimeout(() => {
            this.idle().catch(err => this.log.warn({ err, cid: this.id }));
        }, 15 * 1000);
    }

    protected async run(command: string, ...args: any[]): Promise<any> {
        command = command.toUpperCase();
        if (!this.commands.has(command)) {
            return false;
        }

        if (this.socket.destroyed) {
            const error: any = new Error('Connection not available');
            error.code = 'NoConnection';
            throw error;
        }

        clearTimeout(this.idleStartTimer);

        if (typeof this.preCheck === 'function') {
            await this.preCheck();
        }

        let handler = this.commands.get(command);

        let result = await handler(this, ...args);

        if (command !== 'IDLE') {
            // do not autostart IDLE, if IDLE itself was stopped
            this.autoidle();
        }

        return result;
    }

    protected async processLocks(force?) {
        if (!force && this.processingLock) {
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

        if (!this.locks.length) {
            this.processingLock = false;
            this.log.trace({
                msg: 'Mailbox locking queue processed',
                idling: this.idling
            });
            return;
        }

        this.processingLock = true;

        const release = () => {
            if (this.currentLock) {
                this.log.trace({
                    msg: 'Mailbox lock released',
                    lockId: this.currentLock.lockId,
                    path: this.mailbox && this.mailbox.path,
                    pending: this.locks.length,
                    idling: this.idling
                });
                this.currentLock = false;
            }
            this.processLocks(true).catch(err => this.log.error({ err, cid: this.id }));
        };

        const lock = this.locks.shift();
        const { resolve, reject, path, options, lockId } = lock;

        if (!this.usable || this.socket.destroyed) {
            this.log.trace({ msg: 'Failed to acquire mailbox lock', path, lockId, idling: this.idling });
            // reject all
            let error: any = new Error('Connection not available');
            error.code = 'NoConnection';
            reject(error);
            return await this.processLocks(true);
        }

        if (this.mailbox && this.mailbox.path === path && !!this.mailbox.readOnly === !!options.readOnly) {
            // nothing to do here, already selected
            this.log.trace({
                msg: 'Mailbox lock acquired [existing]',
                path,
                lockId,
                idling: this.idling,
                ...(options.description && { description: options.description })
            });
            this.currentLock = lock;
            return resolve({ path, release });
        } else {
            try {
                // Try to open. Throws if mailbox does not exists or can't open
                await this.mailboxOpen(path, options);
                this.log.trace({
                    msg: 'Mailbox lock acquired [selected]',
                    path,
                    lockId,
                    idling: this.idling,
                    ...(options.description && { description: options.description })
                });
                this.currentLock = lock;
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

                this.log.trace({
                    msg: 'Failed to acquire mailbox lock',
                    path,
                    lockId,
                    idling: this.idling,
                    ...(options.description && { description: options.description }),
                    err
                });
                reject(err);
                await this.processLocks(true);
            }
        }
    }

    protected getLogger() {
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
            synteticLogger[level] = (...args: Parameters<typeof JSON.stringify>) => {
                // using {logger:false} disables logging
                if (this.options.logger !== false) {
                    if (logger) {
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
                }

                if (this.emitLogs && args && args[0] && typeof args[0] === 'object') {
                    let logEntry = {
                        ...args[0],
                        level,
                        t: Date.now(),
                        cid: this.id,
                        lo: ++this.lo
                    };
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

    protected unbind() {
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
    async connect(): Promise<void> {
        let connector = this.secureConnection ? tls : net;

        let opts: any = {
            host: this.host,
            servername: this.servername,
            port: this.port,
            ...this.options.tls
        };

        this.untaggedHandlers.OK = this.initialOK.bind(this);
        this.untaggedHandlers.BYE = this.serverBye.bind(this);
        this.untaggedHandlers.PREAUTH = this.initialPREAUTH.bind(this);

        this.untaggedHandlers.CAPABILITY = this.untaggedCapability.bind(this);
        this.sectionHandlers.CAPABILITY = this.sectionCapability.bind(this);

        this.untaggedHandlers.EXISTS = this.untaggedExists.bind(this);
        this.untaggedHandlers.EXPUNGE = this.untaggedExpunge.bind(this);

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
                let error: any = new Error('Failed to setup proxy connection');
                error.code = err.code || 'ProxyError';
                error._err = err;
                this.log.error({ error, cid: this.id });
                throw error;
            }
        }

        await new Promise((resolve, reject) => {
            this.connectTimeout = setTimeout(() => {
                let err: any = new Error('Failed to establish connection in required time');
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
                    let err: any = new Error(
                        `Failed to receive greeting from server in required time${!this.secureConnection ? '. Maybe should use TLS?' : ''}`
                    );
                    err.code = 'GREEETING_TIMEOUT';
                    err.details = {
                        greetingTimeout: this.options.greetingTimeout || GREETING_TIMEOUT
                    };
                    this.log.error({ err, cid: this.id });
                    setImmediate(() => this.close());
                    reject(err);
                }, this.options.greetingTimeout || GREETING_TIMEOUT);

                this.tls = this.socket instanceof tls.TLSSocket ? this.socket.getCipher() : false;

                let logInfo: any = {
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
                    logInfo.authorized = this.tls.authorized = (this.socket as any).authorized;
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
                    this.socket = (connector as any).connect(opts, onConnect);
                } else {
                    // cleartext socket is already usable
                    this.socket = socket as any;
                    setImmediate(onConnect);
                }
            } else {
                this.socket = (connector as any).connect(opts, onConnect);
            }

            this.writeSocket = this.socket;

            this.socket.on('error', err => {
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
    async logout(): Promise<void> {
        return await this.run('LOGOUT');
    }

    close(): void {
        // clear pending timers
        clearTimeout(this.idleStartTimer);
        clearTimeout(this.upgradeTimeout);
        clearTimeout(this.connectTimeout);

        this.usable = false;
        this.idling = false;

        if (typeof this.initialReject === 'function' && !this.options.verifyOnly) {
            clearTimeout(this.greetingTimeout);
            let reject = this.initialReject;
            this.initialResolve = false;
            this.initialReject = false;
            let err: any = new Error('Unexpected close');
            err.code = `ClosedAfterConnect${this.secureConnection ? 'TLS' : 'Text'}`;
            // still has to go through the logic below
            setImmediate(() => reject(err));
        }

        if (typeof this.preCheck === 'function') {
            this.preCheck().catch(err => this.log.warn({ err, cid: this.id }));
        }

        // reject command that is currently processed
        if (this.currentRequest && this.requestTagMap.has(this.currentRequest.tag)) {
            let request = this.requestTagMap.get(this.currentRequest.tag);
            if (request && ['LOGOUT'].includes(request.command)) {
                this.requestTagMap.delete(request.tag);
                const error: any = new Error('Connection not available');
                error.code = 'NoConnection';
                request.reject(error);
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
                    const error: any = new Error('Connection not available');
                    error.code = 'NoConnection';
                    request.reject(error);
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
                this.writeSocket.destroySoon();
            } catch (err) {
                this.log.error({ err, cid: this.id });
            }
        }

        if (this.socket && !this.socket.destroyed && this.writeSocket !== this.socket) {
            try {
                this.socket.destroySoon();
            } catch (err) {
                this.log.error({ err, cid: this.id });
            }
        }

        this.log.trace({ msg: 'Connection closed', cid: this.id });
        this.emit('close');
    }

    /**
     * Returns current quota
     *
     * @param [path] Optional mailbox path if you want to check quota for specific folder
     * @returns Quota information or `false` if QUTOA extension is not supported or requested path does not exist
     *
     * @example
     * let quota = await client.getQuota();
     * console.log(quota.storage.used, quota.storage.available)
     */
    async getQuota(path?: string): Promise<QuotaResponse | boolean> {
        path = path || 'INBOX';
        return await this.run('QUOTA', path);
    }

    /**
     * Lists available mailboxes as an Array
     *
     * @param [options] defines additional listing options
     * @returns An array of ListResponse objects
     *
     * @example
     * let list = await client.list();
     * list.forEach(mailbox=>console.log(mailbox.path));
     */
    async list(options: ListOptions = {}): Promise<ListResponse[]> {
        let folders = await this.run('LIST', '', '*', options);
        this.folders = new Map(folders.map(folder => [folder.path, folder]));
        return folders;
    }

    /**
     * Lists available mailboxes as a tree structured object
     *
     * @returns Tree structured object
     *
     * @example
     * let tree = await client.listTree();
     * tree.folders.forEach(mailbox=>console.log(mailbox.path));
     */
    async listTree(): Promise<ListTreeResponse> {
        let folders = await this.run('LIST', '', '*');
        this.folders = new Map(folders.map(folder => [folder.path, folder]));
        return getFolderTree(folders);
    }

    /**
     * Performs a no-op call against server
     * @returns {Promise<void>}
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
     * let info = await client.mailboxRename('parent.child', 'Important stuff ❗️');
     * console.log(info.newPath);
     * // "INBOX.Important stuff ❗️" // assumes "INBOX." as namespace prefix
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
     * let info = await client.mailboxDelete('Important stuff ❗️');
     * console.log(info.path);
     * // "INBOX.Important stuff ❗️" // assumes "INBOX." as namespace prefix
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
     * await client.mailboxSubscribe('Important stuff ❗️');
     */
    async mailboxSubscribe(path: string | string[]): Promise<boolean> {
        return await this.run('SUBSCRIBE', path);
    }

    /**
     * Unsubscribes from a mailbox
     *
     * @param path Path for the mailbox to unsubscribe from. Unicode is allowed. If value is an array then it is joined using current delimiter symbols. Namespace prefix is added automatically if required.
     * @returns `true` if unsubscription operation succeeded, `false` otherwise
     *
     * @example
     * await client.mailboxUnsubscribe('Important stuff ❗️');
     */
    async mailboxUnsubscribe(path: string | string[]): Promise<boolean> {
        return await this.run('UNSUBSCRIBE', path);
    }

    /**
     * Opens a mailbox to access messages. You can perform message operations only against an opened mailbox.
     * Using {@link ImapFlow.getMailboxLock()} instead of `mailboxOpen()` is preferred. Both do the same thing
     * but next `getMailboxLock()` call is not executed until previous one is released.
     *
     * @param path Path for the mailbox to open
     * @throws Will throw an error if mailbox does not exist or can not be opened
     *
     * @example
     * let mailbox = await client.mailboxOpen('Important stuff ❗️');
     * console.log(mailbox.exists);
     * // 125
     */
    async mailboxOpen(path: string | string[], options?: MailboxOpenOptions): Promise<MailboxObject> {
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
     * @param path mailbox path to check for (unicode string)
     * @param query defines requested status items
     * @returns status of the indicated mailbox
     *
     * @example
     * let status = await client.status('INBOX', {unseen: true});
     * console.log(status.unseen);
     * // 123
     */
    async status(path: string, query: StatusQuery): Promise<StatusObject> {
        return await this.run('STATUS', path, query);
    }

    /**
     * Starts listening for new or deleted messages from the currently opened mailbox. This method is only required if {@link ImapFlow.Options.disableAutoIdle} is set to `true`.
     *
     * Otherwise, `IDLE` is started by default on connection inactivity.
     *
     * Note: If `idle()` is called manually, it will not return until `IDLE` is finished, which means you would have to call some other command out of scope.
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
     * @param [options]
     * @returns Did the operation succeed or not
     *
     * @example
     * let mailbox = await client.mailboxOpen('INBOX');
     * // mark all unseen messages as seen (and remove other flags)
     * await client.messageFlagsSet({seen: false}, ['\Seen]);
     */
    async messageFlagsSet(range: SequenceString | number[] | SearchObject, flags: string[], options: MessageFlagsOptions = {}): Promise<boolean> {
        range = await this.resolveRange(range, options);
        if (!range) {
            return false;
        }

        let queryOpts = {
            ...options,
            operation: 'set'
        };

        return await this.run('STORE', range, flags, queryOpts);
    }

    /**
     * Adds flags for a message or message range
     *
     * @param range Range to filter the messages
     * @param flags Array of flags to set. Only flags that are permitted to set are used, other flags are ignored
     * @param [options]
     * @returns Did the operation succeed or not
     *
     * @example
     * let mailbox = await client.mailboxOpen('INBOX');
     * // mark all unseen messages as seen (and keep other flags as is)
     * await client.messageFlagsAdd({seen: false}, ['\Seen]);
     */
    async messageFlagsAdd(range: SequenceString | number[] | SearchObject, flags: string[], options: MessageFlagsOptions = {}): Promise<boolean> {
        range = await this.resolveRange(range, options);
        if (!range) {
            return false;
        }

        let queryOpts = {
            ...options,
            operation: 'add'
        };

        return await this.run('STORE', range, flags, queryOpts);
    }

    /**
     * Remove specific flags from a message or message range
     *
     * @param range Range to filter the messages
     * @param flags Array of flags to remove. Only flags that are permitted to set are used, other flags are ignored
     * @param [options]
     * @returns Did the operation succeed or not
     *
     * @example
     * let mailbox = await client.mailboxOpen('INBOX');
     * // mark all seen messages as unseen by removing \\Seen flag
     * await client.messageFlagsRemove({seen: true}, ['\Seen]);
     */
    async messageFlagsRemove(range: SequenceString | number[] | SearchObject, flags: string[], options: MessageFlagsOptions = {}): Promise<boolean> {
        range = await this.resolveRange(range, options);
        if (!range) {
            return false;
        }

        let queryOpts = {
            ...options,
            operation: 'remove'
        };

        return await this.run('STORE', range, flags, queryOpts);
    }

    /**
     * Sets a colored flag for an email. Only supported by mail clients like Apple Mail
     *
     * @param range Range to filter the messages
     * @param color The color to set. One of 'red', 'orange', 'yellow', 'green', 'blue', 'purple', and 'grey'
     * @param [options]
     * @returns Did the operation succeed or not
     *
     * @example
     * let mailbox = await client.mailboxOpen('INBOX');
     * // add a purple flag for all emails
     * await client.setFlagColor('1:*', 'Purple');
     */
    async setFlagColor(range: SequenceString | number[] | SearchObject, color: string, options: Omit<MessageFlagsOptions, 'useLabels'> = {}): Promise<boolean> {
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
            let queryOpts = {
                ...options,
                operation: 'add',
                useLabels: false, // override if set
                // prevent triggering a premature Flags change notification
                silent: flagChanges.remove && flagChanges.remove.length
            };

            addResults = await this.run('STORE', range, flagChanges.add, queryOpts);
        }

        if (flagChanges.remove && flagChanges.remove.length) {
            let queryOpts = {
                ...options,
                operation: 'remove',
                useLabels: false // override if set
            };

            removeResults = await this.run('STORE', range, flagChanges.remove, queryOpts);
        }

        return addResults || removeResults || false;
    }

    /**
     * Delete messages from currently opened mailbox. Method does not indicate info about deleted messages,
     * instead you should be using {@link ImapFlow#expunge} event for this
     *
     * @param range Range to filter the messages
     * @param [options]
     * @returns Did the operation succeed or not
     *
     * @example
     * let mailbox = await client.mailboxOpen('INBOX');
     * // delete all seen messages
     * await client.messageDelete({seen: true});
     */
    async messageDelete(range: SequenceString | number[] | SearchObject, options: MessageOptions = {}): Promise<boolean> {
        range = await this.resolveRange(range, options);
        if (!range) {
            return false;
        }
        return await this.run('EXPUNGE', range, options);
    }

    /**
     * Appends a new message to a mailbox
     *
     * @param path Mailbox path to upload the message to (unicode string)
     * @param content RFC822 formatted email message
     * @param [flags] an array of flags to be set for the uploaded message
     * @param [idate] internal date to be set for the message (defaults to current time)
     * @returns info about uploaded message
     *
     * @example
     * await client.append('INBOX', rawMessageBuffer, ['\\Seen'], new Date(2000, 1, 1));
     */
    async append(path: string, content: string | Buffer, flags?: string[], idate?: Date | string): Promise<AppendResponseObject | false> {
        let response = await this.run('APPEND', path, content, flags, idate);

        if (!response) {
            return false;
        }

        return response;
    }

    /**
     * Copies messages from current mailbox to destination mailbox
     *
     * @param range Range of messages to copy
     * @param destination Mailbox path to copy the messages to
     * @param [options]
     * @returns info about copies messages
     *
     * @example
     * await client.mailboxOpen('INBOX');
     * // copy all messages to a mailbox called "Backup" (must exist)
     * let result = await client.messageCopy('1:*', 'Backup');
     * console.log('Copied %s messages', result.uidMap.size);
     */
    async messageCopy(range: SequenceString | number[] | SearchObject, destination: string, options: MessageOptions = {}): Promise<CopyResponseObject | false> {
        range = await this.resolveRange(range, options);
        if (!range) {
            return false;
        }
        return await this.run('COPY', range, destination, options);
    }

    /**
     * Moves messages from current mailbox to destination mailbox
     *
     * @param range Range of messages to move
     * @param destination Mailbox path to move the messages to
     * @param [options]
     * @returns info about moved messages
     *
     * @example
     * await client.mailboxOpen('INBOX');
     * // move all messages to a mailbox called "Trash" (must exist)
     * let result = await client.messageMove('1:*', 'Trash');
     * console.log('Moved %s messages', result.uidMap.size);
     */
    async messageMove(range: SequenceString | number[] | SearchObject, destination: string, options: MessageOptions = {}): Promise<CopyResponseObject | false> {
        range = await this.resolveRange(range, options);
        if (!range) {
            return false;
        }
        return await this.run('MOVE', range, destination, options);
    }

    /**
     * Search messages from currently opened mailbox
     *
     * @param query Query to filter the messages
     * @param [options]
     * @returns An array of sequence or UID numbers
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
    async search(query: SearchObject, options?: MessageOptions): Promise<number[] | false | undefined> {
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
     * Fetch messages from currently opened mailbox
     *
     * @param range Range of messages to fetch
     * @param query Fetch query
     * @param [options]
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
        range: SequenceString | number[] | SearchObject,
        query: FetchQueryObject,
        options: FetchOptions = {}
    ): AsyncGenerator<FetchMessageObject, false | void, unknown> {
        if (!this.mailbox) {
            // no mailbox selected, nothing to do
            return;
        }

        range = await this.resolveRange(range, options);
        if (!range) {
            return false;
        }

        let finished = false;
        let push: Function | false = false;
        let rowQueue: any[] = [];

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
                if (typeof push === 'function') {
                    push();
                }
            });

        let res;
        while ((res = await getNext())) {
            if (this.isClosed || this.socket.destroyed) {
                let error: any = new Error('Connection closed');
                error.code = 'EConnectionClosed';
                throw error;
            }

            if (res !== null) {
                yield res.response;
                res.next();
            }
        }

        if (!finished) {
            // FETCH never finished!
            let error: any = new Error('FETCH did not finish');
            error.code = 'ENotFinished';
            throw error;
        }
    }

    /**
     * Fetch a single message from currently opened mailbox
     *
     * @param seq Single UID or sequence number of the message to fetch for
     * @param query Fetch query
     * @param [options]
     * @returns Message data object
     *
     * @example
     * let mailbox = await client.mailboxOpen('INBOX');
     * // fetch UID for the last email in the selected mailbox
     * let lastMsg = await client.fetchOne('*', {uid: true})
     * console.log(lastMsg.uid);
     */
    async fetchOne(
        seq: SequenceString,
        query: FetchQueryObject,
        options?: Omit<FetchOptions, 'unchangedSince'>
    ): Promise<FetchMessageObject | false | undefined> {
        if (!this.mailbox) {
            // no mailbox selected, nothing to do
            return;
        }

        if (seq === '*') {
            if (!this.mailbox.exists) {
                return false;
            }
            seq = this.mailbox.exists.toString();
            options = { ...options, uid: false }; // force into a sequence query
        }

        let response = await this.run('FETCH', (seq || '').toString(), query, options);

        if (!response || !response.list || !response.list.length) {
            return false;
        }

        return response.list[0];
    }

    /**
     * Download either full rfc822 formated message or a specific bodystructure part as a Stream.
     * Bodystructure parts are decoded so the resulting stream is a binary file. Text content
     * is automatically converted to UTF-8 charset.
     *
     * @param range UID or sequence number for the message to fetch
     * @param [part] If not set then downloads entire rfc822 formatted message, otherwise downloads specific bodystructure part
     * @param [options]
     * @returns Download data object
     *
     * @example
     * let mailbox = await client.mailboxOpen('INBOX');
     * // download body part nr '1.2' from latest message
     * let {meta, content} = await client.download('*', '1.2');
     * content.pipe(fs.createWriteStream(meta.filename));
     */
    async download(
        range: SequenceString,
        part?: string,
        options?: DownloadOptions
    ): Promise<DownloadObject | { meta?: undefined; content?: undefined } | { response: false; chunk: false }> {
        if (!this.mailbox) {
            // no mailbox selected, nothing to do
            return {};
        }

        options = {
            ...options,
            chunkSize: options?.chunkSize || 64 * 1024,
            maxBytes: options?.maxBytes || Infinity
        };

        let hasMore = true;
        let processed = 0;

        let chunkSize = Number(options.chunkSize) || 64 * 1024;
        let maxBytes = Number(options.maxBytes) || Infinity;

        let uid: any = false;

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

            if (!response.bodyStructure?.childNodes) {
                // single text message
                part = 'TEXT';
            }
        }

        let getNextPart = async (query: any = {}) => {
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

            let result: any = { chunk };
            if (query.size) {
                result.response = response;
            }

            if (query.bodyParts) {
                if (mimeKey === 'header') {
                    result.mime = response.headers;
                } else {
                    result.mime = response.bodyParts?.get(mimeKey);
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

        let meta: any = {
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
                    filename = libmime.decodeWords(filename);
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
     * @param range UID or sequence number for the message to fetch
     * @param parts A list of bodystructure parts
     * @param [options]
     * @returns Download data object
     *
     * @example
     * let mailbox = await client.mailboxOpen('INBOX');
     * // download body parts '2', and '3' from all messages in the selected mailbox
     * let response = await client.downloadMany('*', ['2', '3']);
     * process.stdout.write(response[2].content)
     * process.stdout.write(response[3].content)
     */
    async downloadMany(
        range: SequenceString,
        parts: string[],
        options?: DownloadOptions
    ): Promise<{ response?: boolean } | { [key: string | number]: { content: Buffer; meta?: any } }> {
        if (!this.mailbox) {
            // no mailbox selected, nothing to do
            return {};
        }

        options = {
            chunkSize: 64 * 1024,
            maxBytes: Infinity,
            ...options
        };

        let query: any = { bodyParts: [] };

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
                        filename = libmime.decodeWords(filename);
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

    /**
     * Opens a mailbox if not already open and returns a lock. Next call to `getMailboxLock()` is queued
     * until previous lock is released. This is suggested over {@link ImapFlow.mailboxOpen()} as
     * `getMailboxLock()` gives you a weak transaction while `mailboxOpen()` has no guarantees whatsoever that another
     * mailbox is opened while you try to call multiple fetch or store commands.
     *
     * @param path Path for the mailbox to open
     * @param [options] optional options
     * @param [options.readOnly=false] If `true` then opens mailbox in read-only mode. You can still try to perform write operations but these would probably fail.
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
    async getMailboxLock(path: string | string[], options: { readOnly?: boolean; description?: string } = {}): Promise<MailboxLockObject> {
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

        return await new Promise((resolve, reject) => {
            this.locks.push({ resolve, reject, path, options, lockId });
            this.processLocks().catch(err => reject(err));
        });
    }
}

Object.setPrototypeOf(ImapFlow.prototype, EventEmitter.prototype);

export interface ImapFlow extends StrictEventEmitter<EventEmitter, ImapFlowEvents> {}

interface ImapFlowEvents {
    /**
     * Connection close event. **NB!** ImapFlow does not handle reconncts automatically.
     *
     * So whenever a 'close' event occurs you must create a new connection yourself.
     */
    close: void;

    /**
     * Error event. In most cases getting an error event also means that connection is closed and pending operations should return with a failure.
     *
     * @example
     * client.on('error', err => {
     *     console.log(`Error occurred: ${err.message}`);
     * });
     */
    error: Error;

    /**
     * Message count in currently opened mailbox changed
     *
     * @example
     * client.on('exists', data => {
     *     console.log(`Message count in "${data.path}" is ${data.count}`);
     * });
     */
    exists: {
        /** The mailbox path this event applies to */
        path: string;

        /** Updated count of messages */
        count: number;

        /** Message count before this update */
        prevCount: number;
    };

    /**
     * Deleted message sequence number in currently opened mailbox. One event is fired for every deleted email.
     *
     * @example
     * client.on('expunge', data => {
     *     console.log(`Message #${data.seq} was deleted from "${data.path}"`);
     * });
     */
    expunge: {
        /** The mailbox path this event applies to */
        path: string;

        /** Sequence number of deleted message */
        seq: number;
    };

    /**
     * Flags were updated for a message. Not all servers fire this event.
     *
     * @example
     * client.on('flags', data => {
     *     console.log(`Flag set for #${data.seq} is now "${Array.from(data.flags).join(', ')}"`);
     * });
     */
    flags: {
        /** The mailbox path this event applies to */
        path: string;

        /** Sequence number of updated message */
        seq: number;

        /** UID number of updated message (if server provided this value) */
        uid?: number;

        /** Updated modseq number for the mailbox (if server provided this value) */
        modseq?: bigint;

        /** A set of all flags for the updated message */
        flags: Set<string>;
    };

    /**
     * Mailbox was opened
     *
     * @example
     * client.on('mailboxOpen', mailbox => {
     *     console.log(`Mailbox ${mailbox.path} was opened`);
     * });
     */
    mailboxOpen: MailboxObject;

    /**
     * Mailbox was closed
     *
     * @example
     * client.on('mailboxClose', mailbox => {
     *     console.log(`Mailbox ${mailbox.path} was closed`);
     * });
     */
    mailboxClose: MailboxObject;

    /**
     * Log event if `emitLogs=true`
     *
     * @example
     * client.on('log', entry => {
     *     console.log(`${log.cid} ${log.msg}`);
     * });
     */
    log: Record<string, unknown> & {
        /** The client id */
        cid: string;

        /** The log level */
        level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

        /** The log ordering number */
        lo: number;

        /** The log timestamp */
        ts: number;

        msg?: string;
        err?: unknown;
        src?: string;
        data?: unknown;
        compress?: boolean;
        secure?: boolean;
        throttleDelay?: number;
        delayResponse?: number;
    };

    /** @internal */
    response: any;
}
