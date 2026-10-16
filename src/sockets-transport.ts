// A transport over the `connect()` of the `cloudflare:sockets` API, for runtimes that have it
// but no usable `node:net` or `node:tls` (celld). The socket that API returns is a pair of web
// streams, wrapped here into a Duplex that behaves like the net.Socket ImapFlow drives.
//
// The runtime verifies every TLS certificate against its own root store and takes the SNI name
// from the hostname it connects to, so TLS options that would change either are refused rather
// than silently ignored.

import { Duplex } from 'node:stream';
import { createImapError, type ImapFlowError } from './errors.js';
import { clearTimer, noop, unrefTimer } from './tools.js';
import type { ImapSocket } from './imap-flow.js';
import type { ImapTransport, ImapTransportOptions } from './types.js';

/** The reader of {@link SocketsApiSocket.readable} */
export interface SocketsApiReader {
    read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
    releaseLock(): void;
}

/** The writer of {@link SocketsApiSocket.writable} */
export interface SocketsApiWriter {
    write(chunk: Uint8Array): Promise<void>;
    releaseLock(): void;
}

/** The part of a `cloudflare:sockets` Socket the transport uses */
export interface SocketsApiSocket {
    readable: { getReader(): SocketsApiReader };
    writable: { getWriter(): SocketsApiWriter };
    opened: Promise<{ remoteAddress?: string | undefined; localAddress?: string | undefined } | undefined>;
    closed: Promise<void>;
    close(): Promise<void>;
    startTls(): SocketsApiSocket;
}

/** The `connect()` function of the `cloudflare:sockets` API */
export type SocketsConnect = (
    address: { hostname: string; port: number },
    options?: { secureTransport?: 'off' | 'on' | 'starttls' | undefined; allowHalfOpen?: boolean | undefined } | undefined
) => SocketsApiSocket;

// TLS options the runtime can not honor: it always verifies the certificate against its own
// roots, and has no client certificates
const UNSUPPORTED_TLS_OPTIONS = ['ca', 'cert', 'key', 'pfx', 'passphrase', 'checkServerIdentity'] as const;

function checkOptions(options: ImapTransportOptions): ImapFlowError | null {
    const tlsOptions = options.tls || {};
    const unsupported = UNSUPPORTED_TLS_OPTIONS.find(key => tlsOptions[key] !== undefined);
    const refused =
        tlsOptions.rejectUnauthorized === false
            ? 'tls.rejectUnauthorized=false'
            : options.servername && options.servername !== options.host
              ? 'servername'
              : unsupported && 'tls.' + unsupported;
    return refused ? createImapError(`The ${refused} option is not supported by this transport`, 'UnsupportedTransportOption') : null;
}

// A socket that only reports `err`, emitted on the next tick once the caller listens for it
function failedSocket(err: Error): ImapSocket {
    const socket = new Duplex({ read: noop });
    socket.destroy(err);
    return socket as unknown as ImapSocket;
}

// "1.2.3.4:993" or "[::1]:993"
function splitAddress(address: string | undefined): { address?: string; port?: number } {
    const match = typeof address === 'string' && address.match(/^\[?(.*?)\]?:(\d+)$/);
    return match ? { address: match[1], port: Number(match[2]) } : {};
}

class SocketsDuplex extends Duplex {
    remoteAddress: string | undefined;
    remotePort: number | undefined;
    localAddress: string | undefined;
    localPort: number | undefined;

    private _socket: SocketsApiSocket;
    // Taken once the socket is open: locking the streams of a socket returned by startTls()
    // before its handshake completes stalls the handshake on celld
    private _reader: SocketsApiReader | null = null;
    private _writer: SocketsApiWriter | null = null;
    private _pumping = false;
    private _readRequested = false;
    // The runtime can start TLS only on a socket without a read in flight (with one, celld
    // never completes the handshake), while the read loop always keeps one. So once the client
    // announced a STARTTLS (holdAfterStarttls), reading stops after the tagged line that answers
    // it, the only command in flight then, and resumes only when that line is not an OK.
    private _awaitingStarttls = false;
    private _lineTail = '';
    private _readsHeld = false;
    // Set once startTls() handed the connection to a TLS socket: the read that ends then is not
    // the end of the connection, and closing this socket would close the TLS one
    private _upgraded = false;
    private _plain: SocketsDuplex | null;
    private _timeout = 0;
    private _timer: NodeJS.Timeout | null = null;
    // Traffic only records the time, the one timer re-arms itself for the rest of the idle period
    private _lastActivity = 0;

    constructor(socket: SocketsApiSocket, onConnect: () => void, plain?: SocketsDuplex | undefined) {
        super({ allowHalfOpen: false });
        this._socket = socket;
        this._plain = plain || null;
        socket.opened.then(
            info => {
                if (this.destroyed) {
                    return;
                }
                this._reader = socket.readable.getReader();
                this._writer = socket.writable.getWriter();
                const remote = splitAddress(info?.remoteAddress);
                const local = splitAddress(info?.localAddress);
                this.remoteAddress = remote.address;
                this.remotePort = remote.port;
                this.localAddress = local.address;
                this.localPort = local.port;
                this._touch();
                onConnect();
                if (this._readRequested) {
                    void this._pump();
                }
            },
            (err: Error) => this.destroy(err)
        );
        socket.closed.catch((err: Error) => {
            if (!this._upgraded) {
                this.destroy(err);
            }
        });
    }

    override _read(): void {
        if (this._readsHeld) {
            return;
        }
        if (!this._reader) {
            this._readRequested = true;
        } else if (!this._pumping) {
            void this._pump();
        }
    }

    private async _pump(): Promise<void> {
        const reader = this._reader!;
        this._pumping = true;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (this._upgraded || this.destroyed) {
                    return;
                }
                if (done || !value) {
                    this.push(null);
                    return;
                }
                this._touch();
                const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
                const pushed = this.push(chunk);
                if (this._awaitingStarttls && this._starttlsCompleted(chunk)) {
                    this._readsHeld = true;
                    return;
                }
                if (!pushed) {
                    return;
                }
            }
        } catch (err) {
            if (!this._upgraded) {
                this.destroy(err as Error);
            }
        } finally {
            this._pumping = false;
        }
    }

    // Whether the chunk holds the tagged response of the STARTTLS command and it is an OK
    private _starttlsCompleted(chunk: Buffer): boolean {
        const lines = (this._lineTail + chunk.toString('latin1')).split('\r\n');
        // the incomplete last line, capped: a response line that long is not the one looked for
        this._lineTail = lines.pop()!.slice(-1024);
        for (const line of lines) {
            const tagged = /^(?![*+] )\S+ (OK|NO|BAD)\b/i.exec(line);
            if (tagged) {
                this._awaitingStarttls = false;
                this._lineTail = '';
                return tagged[1].toUpperCase() === 'OK';
            }
        }
        return false;
    }

    /** Stops reading after the tagged response of the STARTTLS command about to be sent, if it is an OK */
    holdAfterStarttls(): void {
        this._awaitingStarttls = true;
        this._lineTail = '';
    }

    override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        if (!this._writer) {
            // ImapFlow writes only after onConnect, this is a misuse
            callback(new Error('Socket is not open yet'));
            return;
        }
        this._touch();
        this._writer.write(chunk).then(() => callback(), callback);
    }

    override _destroy(err: Error | null, callback: (error?: Error | null) => void): void {
        this._clearTimer();
        if (!this._upgraded) {
            this._socket.close().catch(() => false);
        }
        if (this._plain) {
            this._plain.destroy();
        }
        callback(err);
    }

    /** Like net.Socket#setTimeout(): emits 'timeout' after `ms` without traffic, 0 disables */
    setTimeout(ms: number): this {
        this._timeout = ms;
        this._clearTimer();
        this._touch();
        return this;
    }

    setKeepAlive(): this {
        return this;
    }

    /** Hands the connection over to a TLS socket, this one only stays as its transport */
    startTls(onSecure: () => void): SocketsDuplex {
        this._upgraded = true;
        this._clearTimer();
        // workerd refuses to start TLS while the streams are locked, nothing is in flight on them
        this._reader?.releaseLock();
        this._writer?.releaseLock();
        return new SocketsDuplex(this._socket.startTls(), onSecure, this);
    }

    private _touch(): void {
        this._lastActivity = Date.now();
        if (!this._timer) {
            this._arm(this._timeout);
        }
    }

    private _arm(ms: number): void {
        if (this._timeout > 0 && !this.destroyed && !this._upgraded) {
            this._timer = unrefTimer(
                setTimeout(() => {
                    this._timer = null;
                    const idle = Date.now() - this._lastActivity;
                    if (idle >= this._timeout) {
                        this.emit('timeout');
                    } else {
                        this._arm(this._timeout - idle);
                    }
                }, ms)
            );
        }
    }

    private _clearTimer(): void {
        clearTimer(this._timer);
        this._timer = null;
    }
}

/**
 * Builds a transport for the `transport` option from the `connect()` of the `cloudflare:sockets`
 * API, for celld and other runtimes without `node:net` and `node:tls`:
 *
 * ```js
 * import { connect } from 'cloudflare:sockets';
 * const client = new ImapFlow({ host, port: 993, secure: true, auth, transport: createSocketsTransport(connect) });
 * ```
 *
 * The runtime verifies the server certificate against its own root store, so the transport
 * refuses `tls.rejectUnauthorized: false`, a custom `tls.ca`, client certificates and a
 * `servername` that differs from `host`. The socket carries no cipher details, so `client.tls`
 * stays `false` on a secure connection.
 *
 * @param connect - The `connect` export of `cloudflare:sockets`
 * @returns A transport for the `transport` option
 */
export function createSocketsTransport(connect: SocketsConnect): ImapTransport {
    return {
        connect(options, secure, onConnect) {
            // TLS options matter only for a TLS connection, a cleartext one gets them checked if
            // it is upgraded
            const err = secure && checkOptions(options);
            if (err) {
                return failedSocket(err);
            }
            try {
                // Cleartext sockets are opened in starttls mode, which costs nothing until an upgrade
                const socket = connect({ hostname: options.host, port: options.port }, { secureTransport: secure ? 'on' : 'starttls' });
                return new SocketsDuplex(socket, onConnect) as unknown as ImapSocket;
            } catch (err) {
                return failedSocket(err as Error);
            }
        },

        prepareUpgrade(socket) {
            (socket as unknown as SocketsDuplex).holdAfterStarttls();
        },

        upgrade(socket, options, onSecure) {
            const err = checkOptions(options);
            if (err) {
                throw err;
            }
            return (socket as unknown as SocketsDuplex).startTls(onSecure) as unknown as ImapSocket;
        }
    };
}
