// The `transport` option over a socket API built on web streams: the socket opens with a promise
// that resolves to a ReadableStream and a WritableStream of bytes. `cloudflare:sockets` (celld,
// Cloudflare Workers) is one, see sockets-transport.ts; Chrome's Direct Sockets and in-memory
// connections fit the same shape. The streams are wrapped into a Duplex that behaves like the
// net.Socket ImapFlow drives.

import { Duplex } from 'node:stream';
import { clearTimer, noop, unrefTimer } from './tools.js';
import type { CipherNameAndProtocol } from 'node:tls';
import type { ImapTransport, ImapTransportConnectOptions, ImapTransportOptions } from './types.js';

/** The reader of {@link StreamsSocketInfo.readable} */
export interface StreamsReader {
    read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
    releaseLock(): void;
}

/** The writer of {@link StreamsSocketInfo.writable} */
export interface StreamsWriter {
    write(chunk: Uint8Array): Promise<void>;
    releaseLock(): void;
}

/** What a {@link StreamsSocket} resolves with once it is open */
export interface StreamsSocketInfo {
    /** Bytes from the server, a ReadableStream of Uint8Array */
    readable: { getReader(): StreamsReader };
    /** Bytes to the server, a WritableStream of Uint8Array */
    writable: { getWriter(): StreamsWriter };
    remoteAddress?: string | undefined;
    remotePort?: number | undefined;
    localAddress?: string | undefined;
    localPort?: number | undefined;
    /** Details of a TLS connection, reported as `client.tls`. Left out when the API has none */
    tls?: StreamsTlsInfo | undefined;
}

/** What a socket API knows about a TLS connection */
export interface StreamsTlsInfo {
    /** Whether the server certificate was verified */
    authorized: boolean;
    /** Cipher name, e.g. `TLS_AES_256_GCM_SHA384` */
    name?: string | undefined;
    standardName?: string | undefined;
    /** Protocol version, e.g. `TLSv1.3` */
    version?: string | undefined;
}

/** A connection of a web streams socket API, as {@link StreamsTransportApi} opens it */
export interface StreamsSocket {
    /** Resolves once the connection (and the TLS handshake, if any) is established, rejects if it fails */
    opened: Promise<StreamsSocketInfo>;
    /** Rejects if the connection fails after it was opened */
    closed?: Promise<unknown> | undefined;
    /** Closes the connection */
    close(): unknown;
}

/** The socket API that {@link createStreamsTransport} drives */
export interface StreamsTransportApi<S extends StreamsSocket = StreamsSocket> {
    /**
     * Opens a connection, cleartext or TLS as `options.secure` says. Throws to refuse it, for
     * example with an `UnsupportedTransportOption` error for TLS options the API can not honor.
     */
    open(options: ImapTransportConnectOptions): S;
    /**
     * Starts TLS on an open cleartext connection after STARTTLS and returns the TLS connection,
     * the old one stays open as its transport. Throws to refuse the upgrade. Leave it out when
     * the API can not upgrade a connection: ImapFlow then does not try STARTTLS.
     */
    upgrade?: ((socket: S, options: ImapTransportOptions) => S) | undefined;
}

function closeQuietly(socket: StreamsSocket): void {
    try {
        Promise.resolve(socket.close()).catch(noop);
    } catch {
        // already closed
    }
}

class StreamsDuplex<S extends StreamsSocket> extends Duplex {
    remoteAddress: string | undefined;
    remotePort: number | undefined;
    localAddress: string | undefined;
    localPort: number | undefined;
    authorized: boolean | undefined;
    getCipher: (() => CipherNameAndProtocol) | undefined;

    private _api: StreamsTransportApi<S>;
    private _socket: S;
    // Taken once the socket is open: locking the streams of a socket returned by startTls()
    // before its handshake completes stalls the handshake on celld
    private _reader: StreamsReader | null = null;
    private _writer: StreamsWriter | null = null;
    private _pumping = false;
    private _readRequested = false;
    // A runtime may only start TLS on a socket without a read in flight (with one, celld never
    // completes the handshake), while the read loop always keeps one. So once the client
    // announced a STARTTLS (holdAfterStarttls), reading stops after the tagged line that answers
    // it, the only command in flight then, and resumes only when that line is not an OK.
    private _awaitingStarttls = false;
    private _lineTail = '';
    // Set when the partial line got too long to be the one looked for and was dropped: the rest
    // of it, up to the next line break, is skipped too
    private _tailDropped = false;
    private _readsHeld = false;
    // Set once startTls() handed the connection to a TLS socket: the read that ends then is not
    // the end of the connection, and closing this socket would close the TLS one
    private _upgraded = false;
    private _plain: StreamsDuplex<S> | null;
    private _timeout = 0;
    private _timer: NodeJS.Timeout | null = null;
    // Traffic only records the time, the one timer re-arms itself for the rest of the idle period
    private _lastActivity = 0;

    constructor(api: StreamsTransportApi<S>, socket: S, onConnect: () => void, plain?: StreamsDuplex<S> | undefined) {
        super({ allowHalfOpen: false });
        this._api = api;
        this._socket = socket;
        this._plain = plain || null;
        socket.opened.then(
            info => {
                if (this.destroyed) {
                    return;
                }
                try {
                    this._reader = info.readable.getReader();
                    this._writer = info.writable.getWriter();
                } catch (err) {
                    // streams already locked by someone else
                    this.destroy(err as Error);
                    return;
                }
                this.remoteAddress = info.remoteAddress;
                this.remotePort = info.remotePort;
                this.localAddress = info.localAddress;
                this.localPort = info.localPort;
                const tls = info.tls;
                if (tls) {
                    this.authorized = tls.authorized;
                    this.getCipher = () => ({ name: tls.name || '', standardName: tls.standardName || tls.name || '', version: tls.version || '' });
                }
                this._touch();
                onConnect();
                if (this._readRequested) {
                    void this._pump();
                }
            },
            (err: Error) => this.destroy(err)
        );
        socket.closed?.catch((err: Error) => {
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

    // Whether the chunk holds the tagged response of the STARTTLS command and it is an OK. Lines
    // end with LF, CR is optional, as for the parser
    private _starttlsCompleted(chunk: Buffer): boolean {
        const skipFirst = this._tailDropped;
        const lines = (this._lineTail + chunk.toString('latin1')).split('\n');
        const tail = lines.pop()!;
        if (skipFirst && !lines.length) {
            // still inside the dropped line
            return false;
        }
        this._tailDropped = tail.length > 1024;
        this._lineTail = this._tailDropped ? '' : tail;
        for (let i = skipFirst ? 1 : 0; i < lines.length; i++) {
            const tagged = /^(?![*+] )\S+ (OK|NO|BAD)\b/i.exec(lines[i]);
            if (tagged) {
                this._awaitingStarttls = false;
                return tagged[1].toUpperCase() === 'OK';
            }
        }
        return false;
    }

    /** Stops reading after the tagged response of the STARTTLS command about to be sent, if it is an OK */
    holdAfterStarttls(): void {
        this._awaitingStarttls = true;
        this._lineTail = '';
        this._tailDropped = false;
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
            this._close();
        }
        if (this._plain) {
            // the plain connection went with the TLS one, unless the API keeps it open
            this._plain._close();
            this._plain.destroy();
        }
        callback(err);
    }

    // Closes the connection. An API that refuses to close while its streams are locked (Direct
    // Sockets) gets a second attempt with the locks released; releasing them right away would
    // fail the read in flight, which ends the request on celld
    private _close(): void {
        const retry = () => {
            for (const stream of [this._reader, this._writer]) {
                try {
                    stream?.releaseLock();
                } catch {
                    // an older streams implementation refuses with a read in flight
                }
            }
            closeQuietly(this._socket);
        };
        try {
            const closing = this._socket.close() as PromiseLike<unknown> | undefined;
            if (typeof closing?.then === 'function') {
                closing.then(undefined, retry);
            }
        } catch {
            retry();
        }
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
    startTls(options: ImapTransportOptions, onSecure: () => void): StreamsDuplex<S> {
        this._upgraded = true;
        this._clearTimer();
        // workerd refuses to start TLS while the streams are locked, nothing is in flight on them
        this._reader?.releaseLock();
        this._writer?.releaseLock();
        let tlsSocket: S;
        try {
            tlsSocket = this._api.upgrade!(this._socket, options);
        } catch (err) {
            // refused before any handshake, the connection is closed with this socket
            this._upgraded = false;
            throw err;
        }
        return new StreamsDuplex(this._api, tlsSocket, onSecure, this);
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
 * Builds a transport for the `transport` option over a socket API built on web streams. A new
 * API needs only `open()`, and `upgrade()` if it can start TLS on an open connection:
 *
 * ```js
 * const transport = createStreamsTransport({
 *     open: ({ host, port, secure }) => {
 *         const socket = openSomeSocket(host, port, secure);
 *         return { opened: socket.ready.then(() => ({ readable: socket.readable, writable: socket.writable })), close: () => socket.close() };
 *     }
 * });
 * ```
 *
 * The transport stops reading once the server accepted a STARTTLS, so the API never has to start
 * TLS with a read in flight, and releases the stream locks before `upgrade()` is called.
 *
 * @param api - Opens (and upgrades) connections
 * @returns A transport for the `transport` option
 */
export function createStreamsTransport<S extends StreamsSocket>(api: StreamsTransportApi<S>): ImapTransport {
    const transport: ImapTransport = {
        connect: (options, onConnect) => new StreamsDuplex(api, api.open(options), onConnect)
    };
    if (api.upgrade) {
        transport.prepareUpgrade = socket => (socket as StreamsDuplex<S>).holdAfterStarttls();
        transport.upgrade = (socket, options, onSecure) => (socket as StreamsDuplex<S>).startTls(options, onSecure);
    }
    return transport;
}
