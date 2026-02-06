'use strict';

const httpProxyClient = require('nodemailer/lib/smtp-connection/http-proxy-client');
const { SocksClient } = require('socks');
const util = require('util');
const httpProxyClientAsync = util.promisify(httpProxyClient);
const dns = require('dns').promises;
const net = require('net');

// Redacts the password from a parsed URL object before it is logged,
// preventing credentials from appearing in log output.
const hidePassword = proxyUrl => {
    if (proxyUrl.password) {
        proxyUrl.password = '(hidden)';
    }
};

const proxyConnection = async (logger, connectionUrl, host, port) => {
    let proxyUrl = new URL(connectionUrl);

    let protocol = proxyUrl.protocol.replace(/:$/, '').toLowerCase();

    // Pre-resolve the IMAP server hostname to an IP address before passing it to the proxy.
    // Some proxy implementations (especially SOCKS4) do not support hostname resolution,
    // so we resolve DNS on the client side to ensure compatibility.
    if (!net.isIP(host)) {
        let resolveResult = await dns.resolve(host);
        if (resolveResult && resolveResult.length) {
            host = resolveResult[0];
        }
    }

    switch (protocol) {
        // Connect using a HTTP CONNECT method
        case 'http':
        case 'https': {
            try {
                let socket = await httpProxyClientAsync(proxyUrl.href, port, host);
                if (socket) {
                    hidePassword(proxyUrl);
                    logger.info({
                        msg: 'Established a socket via HTTP proxy',
                        proxyUrl: proxyUrl.href,
                        port,
                        host
                    });
                }
                return socket;
            } catch (err) {
                hidePassword(proxyUrl);
                logger.error({
                    msg: 'Failed to establish a socket via HTTP proxy',
                    proxyUrl: proxyUrl.href,
                    port,
                    host,
                    err
                });
                throw err;
            }
        }

        // SOCKS proxy
        case 'socks':
        case 'socks5':
        case 'socks4':
        case 'socks4a': {
            let proxyType = Number(protocol.replace(/\D/g, '')) || 5;

            // targetHost here is the SOCKS proxy server's hostname (not the final IMAP destination).
            // The SOCKS library needs a resolved IP for the proxy host it connects to.
            // The final IMAP destination (host/port) is passed separately as 'destination'.
            let targetHost = proxyUrl.hostname;
            if (!net.isIP(targetHost)) {
                let resolveResult = await dns.resolve(targetHost);
                if (resolveResult && resolveResult.length) {
                    targetHost = resolveResult[0];
                }
            }

            let connectionOpts = {
                proxy: {
                    host: targetHost,
                    port: Number(proxyUrl.port) || 1080,
                    type: proxyType
                },
                destination: {
                    host,
                    port
                },
                command: 'connect',
                set_tcp_nodelay: true
            };

            if (proxyUrl.username || proxyUrl.password) {
                connectionOpts.proxy.userId = proxyUrl.username;
                connectionOpts.proxy.password = proxyUrl.password;
            }

            try {
                const info = await SocksClient.createConnection(connectionOpts);
                if (info && info.socket) {
                    hidePassword(proxyUrl);
                    logger.info({
                        msg: 'Established a socket via SOCKS proxy',
                        proxyUrl: proxyUrl.href,
                        port,
                        host
                    });
                }
                return info.socket;
            } catch (err) {
                hidePassword(proxyUrl);
                logger.error({
                    msg: 'Failed to establish a socket via SOCKS proxy',
                    proxyUrl: proxyUrl.href,
                    port,
                    host,
                    err
                });
                throw err;
            }
        }
    }
};

module.exports = { proxyConnection };
