'use strict';

const { SocksClient } = require('socks');
const dns = require('dns').promises;
const net = require('net');
const tls = require('tls');

const { ConnectionDeadline } = require('./connection-deadline');

// Cap the CONNECT response buffered before the header terminator, so a proxy that never sends
// \r\n\r\n cannot grow memory without bound.
const MAX_RESPONSE_HEADER_BYTES = 64 * 1024;

const DEFAULT_SOCKS_PORT = 1080;

// URL hostnames keep the brackets around an IPv6 literal ("[2001:db8::1]"), which is neither a
// valid input for net.isIP() nor an address net/tls/socks can connect to. Strip them for socket
// options; the parsed URL itself stays intact for logging and credentials.
const unbracketAddress = host => (typeof host === 'string' && host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host);

// CONNECT request lines and Host headers need an IPv6 destination wrapped in brackets. Hostnames
// and IPv4 literals are used as-is, and an already bracketed literal is not bracketed twice.
const formatAuthority = (host, port) => {
    let address = unbracketAddress(host);
    return net.isIPv6(address) ? `[${address}]:${port}` : `${address}:${port}`;
};

// Password-free rendering of the proxy URL, used in every log path. The caller's URL object is
// left untouched so credentials stay available for authentication.
const redactUrl = proxyUrl => {
    let redacted = new URL(proxyUrl.href);
    if (redacted.password) {
        redacted.password = '(hidden)';
    }
    return redacted.href;
};

const proxyError = (message, code) => {
    let err = new Error(message);
    err.code = code || 'ProxyError';
    return err;
};

// URL userinfo is percent-encoded, so it has to be decoded before it can be used as credentials.
// A password containing a bare '%' is not valid percent-encoding and makes decodeURIComponent
// throw, so such values are used as they came in rather than failing the connection.
const decodeUserInfo = value => {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
};

// The socks client attaches its full options object - proxy password included - to the errors it
// throws. Any logger that serializes error properties would then write that password out in clear
// text, so the credentials are dropped before the error is logged or handed to the caller.
const stripProxyCredentials = err => {
    if (err && typeof err === 'object' && err.options) {
        delete err.options;
    }
    return err;
};

// Attaches a benign 'error' listener as soon as the proxied socket exists, so an early
// socket error (before ImapFlow installs its own handlers) cannot surface as an unhandled
// 'error' event and crash the process. The handler is stored on the socket so the caller
// can remove it once it takes ownership of the socket.
const attachEarlyErrorHandler = (logger, socket) => {
    if (!socket || typeof socket.on !== 'function') {
        return;
    }
    socket._earlyErrorHandler = err => {
        logger.error({ msg: 'Proxy socket error before connection setup', err });
    };
    socket.on('error', socket._earlyErrorHandler);
};

// Removes the handler installed by attachEarlyErrorHandler once the caller takes ownership
// of the socket. Keeps the internal `_earlyErrorHandler` contract inside this module.
const detachEarlyErrorHandler = socket => {
    if (socket && socket._earlyErrorHandler) {
        socket.removeListener('error', socket._earlyErrorHandler);
        socket._earlyErrorHandler = null;
    }
};

/**
 * Establishes a tunnel through an HTTP or HTTPS proxy with a CONNECT request.
 *
 * ImapFlow owns this instead of using a bundled helper because the connection-wide deadline has
 * to apply here: the socket is retained as soon as it exists, so an expiry destroys the in-flight
 * socket immediately, and concurrent connections cannot share a single process-global timeout.
 *
 * The destination hostname is passed through unresolved - resolving it is the proxy's job, which
 * is also what keeps DNS traffic off the client for HTTP proxies.
 *
 * @param {Object} params
 * @param {Object} params.logger Logger instance.
 * @param {URL} params.proxyUrl Parsed proxy URL (credentials intact).
 * @param {Boolean} params.secureProxy Whether the proxy endpoint itself speaks TLS.
 * @param {String} params.proxyHost Proxy endpoint host, IPv6 literals unbracketed.
 * @param {Number} params.proxyPort Proxy endpoint port.
 * @param {String} params.host Destination host (hostname or IP literal).
 * @param {Number} params.port Destination port.
 * @param {ConnectionDeadline} params.deadline Shared connection deadline.
 * @returns {Promise<Object>} The established socket, tunnelled to the destination.
 */
const httpConnect = async ({ logger, proxyUrl, secureProxy, proxyHost, proxyPort, host, port, deadline }) => {
    // Reject CRLF in the destination before it reaches the CONNECT request line and Host header.
    // A tainted host/port could otherwise inject additional headers (HTTP request splitting).
    let destinationPort = Number(port) || 0;
    if (!destinationPort || /[\r\n]/.test(host)) {
        throw proxyError('Invalid proxy destination', 'EPROXY');
    }

    let authority = formatAuthority(host, destinationPort);

    let remaining = deadline.remaining();
    if (!remaining) {
        throw deadline.error();
    }

    let socket = null;

    return await new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        let headers = '';

        const onSocketData = chunk => {
            // Scan only the newly arrived bytes (plus the 3 that a terminator could straddle),
            // so a proxy that dribbles its headers cannot turn this into a quadratic rescan.
            let searchFrom = Math.max(0, headers.length - 3);
            headers += chunk.toString('binary');

            let terminator = headers.indexOf('\r\n\r\n', searchFrom);
            if (terminator < 0) {
                if (headers.length > MAX_RESPONSE_HEADER_BYTES) {
                    fail(proxyError('Proxy response headers too large', 'EPROXY'));
                }
                return;
            }

            // The header block is complete, so this listener must stop consuming before anything
            // is put back: unshifting while still subscribed re-emits the data straight back into
            // this handler, which would swallow it. Pausing hands the socket over cleanly - the
            // next owner resumes it (ImapFlow pipes it into the parser).
            socket.removeListener('data', onSocketData);
            socket.pause();

            // Anything after the header terminator already belongs to the tunnelled stream (a
            // server greeting that the proxy coalesced with its own response) and has to be
            // preserved for the next consumer. It is put back as the original bytes, taken from
            // this chunk rather than round-tripped through a string.
            let headerBytes = terminator + 4;
            let consumedFromChunk = chunk.length - (headers.length - headerBytes);
            if (consumedFromChunk < chunk.length) {
                socket.unshift(chunk.subarray(consumedFromChunk));
            }
            headers = headers.slice(0, terminator);

            let status = headers.match(/^HTTP\/\d+\.\d+ (\d+)/i);
            if (!status || (status[1] || '').charAt(0) !== '2') {
                return fail(proxyError(`Invalid response from proxy${status ? `: ${status[1]}` : ''}`, 'EPROXY'));
            }

            succeed();
        };

        // Single settlement path: temporary listeners and the deadline timer are dropped exactly
        // once, so a late socket event cannot settle the promise twice or leave a timer armed.
        const cleanup = () => {
            clearTimeout(timer);
            timer = null;
            if (socket) {
                // Every temporary listener goes, the connect callback included: after settlement
                // no socket event may run any of this again.
                socket.removeListener('connect', onConnected);
                socket.removeListener('data', onSocketData);
                socket.removeListener('error', fail);
                socket.removeListener('close', onEarlyClose);
            }
        };

        function fail(err) {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            if (socket) {
                socket.destroy();
            }
            reject(err);
        }

        function succeed() {
            settled = true;
            cleanup();
            resolve(socket);
        }

        function onEarlyClose() {
            fail(proxyError('Proxy closed the connection before the tunnel was established', 'EPROXY'));
        }

        timer = setTimeout(() => fail(deadline.error()), remaining);

        let connectOptions = { host: proxyHost, port: proxyPort };
        if (secureProxy) {
            // Verify the proxy's certificate (Node default) and target SNI plus hostname
            // verification at the proxy endpoint rather than the IMAP destination. An IP-literal
            // endpoint gets no servername, which would be an invalid SNI value.
            if (!net.isIP(proxyHost)) {
                connectOptions.servername = proxyHost;
            }
        }

        // Declared as a function so cleanup() above can detach it (the connect callback is
        // registered as a one-shot 'connect' listener by net/tls).
        function onConnected() {
            let requestHeaders = {
                Host: authority,
                Connection: 'close'
            };

            if (proxyUrl.username || proxyUrl.password) {
                let credentials = `${decodeUserInfo(proxyUrl.username)}:${decodeUserInfo(proxyUrl.password)}`;
                requestHeaders['Proxy-Authorization'] = `Basic ${Buffer.from(credentials).toString('base64')}`;
            }

            socket.write(
                `CONNECT ${authority} HTTP/1.1\r\n` +
                    Object.keys(requestHeaders)
                        .map(key => `${key}: ${requestHeaders[key]}`)
                        .join('\r\n') +
                    '\r\n\r\n'
            );

            socket.on('data', onSocketData);
        }

        // The socket is retained as soon as it is created, so an expiry can destroy it at once.
        socket = secureProxy ? tls.connect(connectOptions, onConnected) : net.connect(connectOptions, onConnected);
        socket.once('error', fail);
        socket.once('close', onEarlyClose);
    })
        .then(established => {
            logger.info({
                msg: `Established a socket via HTTP proxy`,
                proxyUrl: redactUrl(proxyUrl),
                port,
                host
            });
            attachEarlyErrorHandler(logger, established);
            return established;
        })
        .catch(err => {
            logger.error({
                msg: 'Failed to establish a socket via HTTP proxy',
                proxyUrl: redactUrl(proxyUrl),
                port,
                host,
                err
            });
            throw err;
        });
};

/**
 * Resolves a destination hostname to an IPv4 address. Only used for SOCKS4, which has no IPv6
 * destination address type and no hostname form of its own.
 *
 * @param {String} hostname Destination hostname.
 * @param {ConnectionDeadline} deadline Shared connection deadline.
 * @returns {Promise<String>} An IPv4 address.
 */
const resolveIPv4 = async (hostname, deadline) => {
    let addresses = await deadline.race(dns.resolve4(hostname));
    if (!addresses || !addresses.length) {
        throw proxyError(`Could not resolve an IPv4 address for ${hostname}`, 'EPROXY');
    }
    return addresses[0];
};

/**
 * Establishes a tunnel through a SOCKS proxy.
 *
 * DNS policy per protocol, because the `socks` client picks the SOCKS4 or SOCKS4a wire format from
 * the destination value alone and offers no switch of its own:
 *   * SOCKS4  - destination hostnames are resolved locally to IPv4. Passing a hostname would
 *               silently produce a SOCKS4a request that a plain SOCKS4 proxy cannot answer.
 *   * SOCKS4a - destination hostnames are preserved for remote DNS.
 *   * SOCKS5  - destination hostnames are preserved for remote DNS, IP literals pass through.
 * IPv6 destination literals are rejected for both SOCKS4 and SOCKS4a: neither can carry them, and
 * the dependency would write the literal into the SOCKS4a hostname field instead.
 *
 * @param {Object} params
 * @param {Object} params.logger Logger instance.
 * @param {URL} params.proxyUrl Parsed proxy URL (credentials intact).
 * @param {String} params.protocol Configured proxy protocol (socks, socks4, socks4a, socks5).
 * @param {String} params.proxyHost Proxy endpoint host, IPv6 literals unbracketed.
 * @param {Number} params.proxyPort Proxy endpoint port.
 * @param {String} params.host Destination host (hostname or IP literal).
 * @param {Number} params.port Destination port.
 * @param {ConnectionDeadline} params.deadline Shared connection deadline.
 * @returns {Promise<Object>} The established socket, tunnelled to the destination.
 */
const socksConnect = async ({ logger, proxyUrl, protocol, proxyHost, proxyPort, host, port, deadline }) => {
    let proxyType = protocol === 'socks4' || protocol === 'socks4a' ? 4 : 5;
    let destinationHost = unbracketAddress(host);

    try {
        if (proxyType === 4) {
            if (net.isIPv6(destinationHost)) {
                throw proxyError(`SOCKS4 and SOCKS4a cannot address IPv6 destinations (${destinationHost})`, 'UnsupportedProxyAddress');
            }

            if (protocol === 'socks4' && !net.isIP(destinationHost)) {
                destinationHost = await resolveIPv4(destinationHost, deadline);
            }
        }

        let connectionOpts = {
            proxy: {
                // The endpoint is handed to net.Socket.connect() by the dependency, so a hostname
                // is left unresolved and gets Node's normal lookup and connection behavior.
                host: proxyHost,
                port: proxyPort,
                type: proxyType
            },
            destination: {
                host: destinationHost,
                port
            },
            command: 'connect',
            set_tcp_nodelay: true
        };

        if (proxyUrl.username || proxyUrl.password) {
            connectionOpts.proxy.userId = proxyUrl.username;
            connectionOpts.proxy.password = proxyUrl.password;
        }

        // The dependency treats a zero timeout as its own 30 second default, so only a strictly
        // positive remaining budget may be passed.
        let remaining = deadline.remaining();
        if (!remaining) {
            throw deadline.error();
        }
        connectionOpts.timeout = remaining;

        const info = await deadline.race(SocksClient.createConnection(connectionOpts));
        if (!info || !info.socket) {
            throw proxyError('SOCKS proxy did not return a socket', 'EPROXY');
        }

        logger.info({
            msg: 'Established a socket via SOCKS proxy',
            proxyUrl: redactUrl(proxyUrl),
            port,
            host
        });
        attachEarlyErrorHandler(logger, info.socket);

        return info.socket;
    } catch (caught) {
        // A dependency expiry and the shared deadline are reported with the same
        // CONNECT_TIMEOUT shape, so a caller does not need to know which noticed first.
        let err = deadline.normalize(stripProxyCredentials(caught));
        stripProxyCredentials(err._err);

        logger.error({
            msg: 'Failed to establish a socket via SOCKS proxy',
            proxyUrl: redactUrl(proxyUrl),
            port,
            host,
            err
        });
        throw err;
    }
};

/**
 * Opens a socket to `host`:`port` through the configured proxy.
 *
 * @param {Object} logger Logger instance.
 * @param {String} connectionUrl Proxy URL (http, https, socks, socks4, socks4a, socks5).
 * @param {String} host Destination host, passed through unresolved wherever the proxy protocol
 *   can resolve it itself.
 * @param {Number} port Destination port.
 * @param {Object} [options]
 * @param {ConnectionDeadline} [options.deadline] Shared connection deadline. Proxy DNS and
 *   negotiation run inside it, so a stalled proxy cannot exceed the configured connectionTimeout.
 * @param {Number} [options.connectionTimeout] Used to build a deadline when none was passed.
 * @returns {Promise<Object|undefined>} The tunnelled socket, or undefined for an unknown protocol.
 */
const proxyConnection = async (logger, connectionUrl, host, port, options) => {
    options = options || {};

    let deadline = options.deadline || new ConnectionDeadline(options.connectionTimeout);
    deadline.check();

    let proxyUrl = new URL(connectionUrl);
    let protocol = proxyUrl.protocol.replace(/:$/, '').toLowerCase();

    // ImapFlow performs no DNS lookup of its own for the proxy endpoint: net, tls and the SOCKS
    // client all resolve a hostname endpoint themselves, which keeps Node's normal connection
    // behavior (including address-family selection) instead of pinning one address.
    let proxyHost = unbracketAddress(proxyUrl.hostname);

    switch (protocol) {
        // Connect using a HTTP CONNECT method
        case 'http':
        case 'https':
            return await httpConnect({
                logger,
                proxyUrl,
                secureProxy: protocol === 'https',
                proxyHost,
                proxyPort: Number(proxyUrl.port) || (protocol === 'https' ? 443 : 80),
                host,
                port,
                deadline
            });

        // SOCKS proxy
        case 'socks':
        case 'socks5':
        case 'socks4':
        case 'socks4a':
            return await socksConnect({
                logger,
                proxyUrl,
                protocol,
                proxyHost,
                proxyPort: Number(proxyUrl.port) || DEFAULT_SOCKS_PORT,
                host,
                port,
                deadline
            });
    }
};

module.exports = { proxyConnection, detachEarlyErrorHandler };
