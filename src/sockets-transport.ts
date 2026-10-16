// The `transport` option over the `connect()` of the `cloudflare:sockets` API, for runtimes that
// have it but no usable `node:net` or `node:tls` (celld, Cloudflare Workers). A thin adapter of
// the API to createStreamsTransport().
//
// The runtime verifies every TLS certificate against its own root store and takes the SNI name
// from the hostname it connects to, so TLS options that would change either are refused rather
// than silently ignored.

import { createImapError } from './errors.js';
import { createStreamsTransport, type StreamsReader, type StreamsSocket, type StreamsWriter } from './streams-transport.js';
import type { ImapTransport, ImapTransportOptions } from './types.js';

/** The part of a `cloudflare:sockets` Socket the transport uses */
export interface SocketsApiSocket {
    readable: { getReader(): StreamsReader };
    writable: { getWriter(): StreamsWriter };
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

function refuse(option: string): never {
    throw createImapError(`The ${option} option is not supported by this transport`, 'UnsupportedTransportOption');
}

function assertOptions(options: ImapTransportOptions): void {
    const tlsOptions = options.tls || {};
    if (tlsOptions.rejectUnauthorized === false) {
        refuse('tls.rejectUnauthorized=false');
    }
    if (options.servername && options.servername !== options.host) {
        refuse('servername');
    }
    const unsupported = UNSUPPORTED_TLS_OPTIONS.find(key => tlsOptions[key] !== undefined);
    if (unsupported) {
        refuse('tls.' + unsupported);
    }
}

// "1.2.3.4:993" or "[::1]:993"
function splitAddress(address: string | undefined): { address?: string; port?: number } {
    const match = typeof address === 'string' && address.match(/^\[?(.*?)\]?:(\d+)$/);
    return match ? { address: match[1], port: Number(match[2]) } : {};
}

interface WrappedSocket extends StreamsSocket {
    raw: SocketsApiSocket;
}

function wrap(raw: SocketsApiSocket): WrappedSocket {
    return {
        raw,
        opened: raw.opened.then(info => {
            const remote = splitAddress(info?.remoteAddress);
            const local = splitAddress(info?.localAddress);
            return {
                readable: raw.readable,
                writable: raw.writable,
                remoteAddress: remote.address,
                remotePort: remote.port,
                localAddress: local.address,
                localPort: local.port
            };
        }),
        closed: raw.closed,
        close: () => raw.close()
    };
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
    return createStreamsTransport<WrappedSocket>({
        open(options) {
            // TLS options matter only for a TLS connection, a cleartext one gets them checked if
            // it is upgraded
            if (options.secure) {
                assertOptions(options);
            }
            // Cleartext sockets are opened in starttls mode, which costs nothing until an upgrade
            return wrap(connect({ hostname: options.host, port: options.port }, { secureTransport: options.secure ? 'on' : 'starttls' }));
        },

        upgrade(socket, options) {
            assertOptions(options);
            return wrap(socket.raw.startTls());
        }
    });
}
