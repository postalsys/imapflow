'use strict';

const httpProxyClient = require('nodemailer/lib/smtp-connection/http-proxy-client');
const { SocksClient } = require('socks');
const util = require('util');
const httpProxyClientAsync = util.promisify(httpProxyClient);
const dns = require('dns').promises;
const net = require('net');

const proxyConnection = async (logger, connectionUrl, host, port) => {
    let proxyUrl = new URL(connectionUrl);

    let protocol = proxyUrl.protocol.replace(/:$/, '').toLowerCase();

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
                    if (proxyUrl.password) {
                        proxyUrl.password = '(hidden)';
                    }
                    logger.info({
                        msg: 'Established a socket via HTTP proxy',
                        proxyUrl: proxyUrl.href,
                        port,
                        host
                    });
                }
                return socket;
            } catch (err) {
                if (proxyUrl.password) {
                    proxyUrl.password = '(hidden)';
                }
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
                    if (proxyUrl.password) {
                        proxyUrl.password = '(hidden)';
                    }
                    logger.info({
                        msg: 'Established a socket via SOCKS proxy',
                        proxyUrl: proxyUrl.href,
                        port,
                        host
                    });
                }
                return info.socket;
            } catch (err) {
                if (proxyUrl.password) {
                    proxyUrl.password = '(hidden)';
                }
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
