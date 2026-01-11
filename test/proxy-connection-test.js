'use strict';

const proxyquire = require('proxyquire').noCallThru();

// Mock socket object
const createMockSocket = () => ({
    on: () => {},
    write: () => {},
    end: () => {},
    destroy: () => {}
});

// Mock logger
const createMockLogger = () => {
    const logs = { info: [], error: [] };
    return {
        info: msg => logs.info.push(msg),
        error: msg => logs.error.push(msg),
        _logs: logs
    };
};

// ============================================
// HTTP Proxy Tests
// ============================================

module.exports['Proxy Connection: HTTP proxy success'] = async test => {
    const mockSocket = createMockSocket();
    const logger = createMockLogger();

    const { proxyConnection } = proxyquire('../lib/proxy-connection', {
        'nodemailer/lib/smtp-connection/http-proxy-client': (url, port, host, cb) => {
            cb(null, mockSocket);
        },
        socks: { SocksClient: {} },
        dns: { promises: { resolve: async () => ['127.0.0.1'] } },
        net: { isIP: () => true }
    });

    const socket = await proxyConnection(logger, 'http://proxy.example.com:8080', '192.168.1.1', 993);

    test.equal(socket, mockSocket);
    test.equal(logger._logs.info.length, 1);
    test.ok(logger._logs.info[0].msg.includes('HTTP proxy'));
    test.done();
};

module.exports['Proxy Connection: HTTPS proxy success'] = async test => {
    const mockSocket = createMockSocket();
    const logger = createMockLogger();

    const { proxyConnection } = proxyquire('../lib/proxy-connection', {
        'nodemailer/lib/smtp-connection/http-proxy-client': (url, port, host, cb) => {
            cb(null, mockSocket);
        },
        socks: { SocksClient: {} },
        dns: { promises: { resolve: async () => ['127.0.0.1'] } },
        net: { isIP: () => true }
    });

    const socket = await proxyConnection(logger, 'https://proxy.example.com:8080', '192.168.1.1', 993);

    test.equal(socket, mockSocket);
    test.equal(logger._logs.info.length, 1);
    test.done();
};

module.exports['Proxy Connection: HTTP proxy with password hides it in logs'] = async test => {
    const mockSocket = createMockSocket();
    const logger = createMockLogger();

    const { proxyConnection } = proxyquire('../lib/proxy-connection', {
        'nodemailer/lib/smtp-connection/http-proxy-client': (url, port, host, cb) => {
            cb(null, mockSocket);
        },
        socks: { SocksClient: {} },
        dns: { promises: { resolve: async () => ['127.0.0.1'] } },
        net: { isIP: () => true }
    });

    await proxyConnection(logger, 'http://user:secret123@proxy.example.com:8080', '192.168.1.1', 993);

    test.equal(logger._logs.info.length, 1);
    test.ok(!logger._logs.info[0].proxyUrl.includes('secret123'));
    test.ok(logger._logs.info[0].proxyUrl.includes('(hidden)'));
    test.done();
};

module.exports['Proxy Connection: HTTP proxy failure'] = async test => {
    const logger = createMockLogger();
    const testError = new Error('Connection refused');

    const { proxyConnection } = proxyquire('../lib/proxy-connection', {
        'nodemailer/lib/smtp-connection/http-proxy-client': (url, port, host, cb) => {
            cb(testError);
        },
        socks: { SocksClient: {} },
        dns: { promises: { resolve: async () => ['127.0.0.1'] } },
        net: { isIP: () => true }
    });

    try {
        await proxyConnection(logger, 'http://proxy.example.com:8080', '192.168.1.1', 993);
        test.ok(false, 'Should have thrown');
    } catch (err) {
        test.equal(err, testError);
        test.equal(logger._logs.error.length, 1);
        test.ok(logger._logs.error[0].msg.includes('Failed'));
    }

    test.done();
};

module.exports['Proxy Connection: HTTP proxy failure hides password'] = async test => {
    const logger = createMockLogger();

    const { proxyConnection } = proxyquire('../lib/proxy-connection', {
        'nodemailer/lib/smtp-connection/http-proxy-client': (url, port, host, cb) => {
            cb(new Error('Failed'));
        },
        socks: { SocksClient: {} },
        dns: { promises: { resolve: async () => ['127.0.0.1'] } },
        net: { isIP: () => true }
    });

    try {
        await proxyConnection(logger, 'http://user:secret@proxy.example.com:8080', '192.168.1.1', 993);
    } catch (err) {
        // Error expected - we just need to verify logging
        err.expected = true;
        test.ok(!logger._logs.error[0].proxyUrl.includes('secret'));
        test.ok(logger._logs.error[0].proxyUrl.includes('(hidden)'));
    }

    test.done();
};

// ============================================
// SOCKS Proxy Tests
// ============================================

module.exports['Proxy Connection: SOCKS5 proxy success'] = async test => {
    const mockSocket = createMockSocket();
    const logger = createMockLogger();

    const { proxyConnection } = proxyquire('../lib/proxy-connection', {
        'nodemailer/lib/smtp-connection/http-proxy-client': () => {},
        socks: {
            SocksClient: {
                createConnection: async opts => {
                    test.equal(opts.proxy.type, 5);
                    test.equal(opts.command, 'connect');
                    return { socket: mockSocket };
                }
            }
        },
        dns: { promises: { resolve: async () => ['127.0.0.1'] } },
        net: { isIP: () => true }
    });

    const socket = await proxyConnection(logger, 'socks5://proxy.example.com:1080', '192.168.1.1', 993);

    test.equal(socket, mockSocket);
    test.equal(logger._logs.info.length, 1);
    test.ok(logger._logs.info[0].msg.includes('SOCKS proxy'));
    test.done();
};

module.exports['Proxy Connection: SOCKS proxy (defaults to SOCKS5)'] = async test => {
    const mockSocket = createMockSocket();
    const logger = createMockLogger();

    const { proxyConnection } = proxyquire('../lib/proxy-connection', {
        'nodemailer/lib/smtp-connection/http-proxy-client': () => {},
        socks: {
            SocksClient: {
                createConnection: async opts => {
                    test.equal(opts.proxy.type, 5); // Default to SOCKS5
                    return { socket: mockSocket };
                }
            }
        },
        dns: { promises: { resolve: async () => ['127.0.0.1'] } },
        net: { isIP: () => true }
    });

    await proxyConnection(logger, 'socks://proxy.example.com:1080', '192.168.1.1', 993);
    test.done();
};

module.exports['Proxy Connection: SOCKS4 proxy'] = async test => {
    const mockSocket = createMockSocket();
    const logger = createMockLogger();

    const { proxyConnection } = proxyquire('../lib/proxy-connection', {
        'nodemailer/lib/smtp-connection/http-proxy-client': () => {},
        socks: {
            SocksClient: {
                createConnection: async opts => {
                    test.equal(opts.proxy.type, 4);
                    return { socket: mockSocket };
                }
            }
        },
        dns: { promises: { resolve: async () => ['127.0.0.1'] } },
        net: { isIP: () => true }
    });

    await proxyConnection(logger, 'socks4://proxy.example.com:1080', '192.168.1.1', 993);
    test.done();
};

module.exports['Proxy Connection: SOCKS4a proxy'] = async test => {
    const mockSocket = createMockSocket();
    const logger = createMockLogger();

    const { proxyConnection } = proxyquire('../lib/proxy-connection', {
        'nodemailer/lib/smtp-connection/http-proxy-client': () => {},
        socks: {
            SocksClient: {
                createConnection: async opts => {
                    test.equal(opts.proxy.type, 4);
                    return { socket: mockSocket };
                }
            }
        },
        dns: { promises: { resolve: async () => ['127.0.0.1'] } },
        net: { isIP: () => true }
    });

    await proxyConnection(logger, 'socks4a://proxy.example.com:1080', '192.168.1.1', 993);
    test.done();
};

module.exports['Proxy Connection: SOCKS proxy with authentication'] = async test => {
    const mockSocket = createMockSocket();
    const logger = createMockLogger();

    const { proxyConnection } = proxyquire('../lib/proxy-connection', {
        'nodemailer/lib/smtp-connection/http-proxy-client': () => {},
        socks: {
            SocksClient: {
                createConnection: async opts => {
                    test.equal(opts.proxy.userId, 'testuser');
                    test.equal(opts.proxy.password, 'testpass');
                    return { socket: mockSocket };
                }
            }
        },
        dns: { promises: { resolve: async () => ['127.0.0.1'] } },
        net: { isIP: () => true }
    });

    await proxyConnection(logger, 'socks5://testuser:testpass@proxy.example.com:1080', '192.168.1.1', 993);
    test.done();
};

module.exports['Proxy Connection: SOCKS proxy hides password in logs'] = async test => {
    const mockSocket = createMockSocket();
    const logger = createMockLogger();

    const { proxyConnection } = proxyquire('../lib/proxy-connection', {
        'nodemailer/lib/smtp-connection/http-proxy-client': () => {},
        socks: {
            SocksClient: {
                createConnection: async () => ({ socket: mockSocket })
            }
        },
        dns: { promises: { resolve: async () => ['127.0.0.1'] } },
        net: { isIP: () => true }
    });

    await proxyConnection(logger, 'socks5://user:secretpass@proxy.example.com:1080', '192.168.1.1', 993);

    test.ok(!logger._logs.info[0].proxyUrl.includes('secretpass'));
    test.ok(logger._logs.info[0].proxyUrl.includes('(hidden)'));
    test.done();
};

module.exports['Proxy Connection: SOCKS proxy default port'] = async test => {
    const mockSocket = createMockSocket();
    const logger = createMockLogger();

    const { proxyConnection } = proxyquire('../lib/proxy-connection', {
        'nodemailer/lib/smtp-connection/http-proxy-client': () => {},
        socks: {
            SocksClient: {
                createConnection: async opts => {
                    test.equal(opts.proxy.port, 1080); // Default SOCKS port
                    return { socket: mockSocket };
                }
            }
        },
        dns: { promises: { resolve: async () => ['127.0.0.1'] } },
        net: { isIP: () => true }
    });

    await proxyConnection(logger, 'socks5://proxy.example.com', '192.168.1.1', 993);
    test.done();
};

module.exports['Proxy Connection: SOCKS proxy failure'] = async test => {
    const logger = createMockLogger();
    const testError = new Error('SOCKS connection failed');

    const { proxyConnection } = proxyquire('../lib/proxy-connection', {
        'nodemailer/lib/smtp-connection/http-proxy-client': () => {},
        socks: {
            SocksClient: {
                createConnection: async () => {
                    throw testError;
                }
            }
        },
        dns: { promises: { resolve: async () => ['127.0.0.1'] } },
        net: { isIP: () => true }
    });

    try {
        await proxyConnection(logger, 'socks5://proxy.example.com:1080', '192.168.1.1', 993);
        test.ok(false, 'Should have thrown');
    } catch (err) {
        test.equal(err, testError);
        test.equal(logger._logs.error.length, 1);
        test.ok(logger._logs.error[0].msg.includes('Failed'));
    }

    test.done();
};

module.exports['Proxy Connection: SOCKS proxy failure hides password'] = async test => {
    const logger = createMockLogger();

    const { proxyConnection } = proxyquire('../lib/proxy-connection', {
        'nodemailer/lib/smtp-connection/http-proxy-client': () => {},
        socks: {
            SocksClient: {
                createConnection: async () => {
                    throw new Error('Failed');
                }
            }
        },
        dns: { promises: { resolve: async () => ['127.0.0.1'] } },
        net: { isIP: () => true }
    });

    try {
        await proxyConnection(logger, 'socks5://user:secret@proxy.example.com:1080', '192.168.1.1', 993);
    } catch (err) {
        // Error expected - we just need to verify logging
        err.expected = true;
        test.ok(!logger._logs.error[0].proxyUrl.includes('secret'));
        test.ok(logger._logs.error[0].proxyUrl.includes('(hidden)'));
    }

    test.done();
};

// ============================================
// DNS Resolution Tests
// ============================================

module.exports['Proxy Connection: Resolves hostname to IP'] = async test => {
    const mockSocket = createMockSocket();
    const logger = createMockLogger();
    let resolvedHost = null;

    const { proxyConnection } = proxyquire('../lib/proxy-connection', {
        'nodemailer/lib/smtp-connection/http-proxy-client': (url, port, host, cb) => {
            resolvedHost = host;
            cb(null, mockSocket);
        },
        socks: { SocksClient: {} },
        dns: {
            promises: {
                resolve: async hostname => {
                    if (hostname === 'mail.example.com') {
                        return ['93.184.216.34'];
                    }
                    return [];
                }
            }
        },
        net: { isIP: host => /^\d+\.\d+\.\d+\.\d+$/.test(host) }
    });

    await proxyConnection(logger, 'http://proxy.example.com:8080', 'mail.example.com', 993);

    test.equal(resolvedHost, '93.184.216.34');
    test.done();
};

module.exports['Proxy Connection: Skips DNS for IP addresses'] = async test => {
    const mockSocket = createMockSocket();
    const logger = createMockLogger();
    let dnsResolveCalled = false;

    const { proxyConnection } = proxyquire('../lib/proxy-connection', {
        'nodemailer/lib/smtp-connection/http-proxy-client': (url, port, host, cb) => {
            cb(null, mockSocket);
        },
        socks: { SocksClient: {} },
        dns: {
            promises: {
                resolve: async () => {
                    dnsResolveCalled = true;
                    return ['127.0.0.1'];
                }
            }
        },
        net: { isIP: () => true } // Pretend it's already an IP
    });

    await proxyConnection(logger, 'http://proxy.example.com:8080', '192.168.1.1', 993);

    test.equal(dnsResolveCalled, false);
    test.done();
};

module.exports['Proxy Connection: SOCKS resolves proxy hostname'] = async test => {
    const mockSocket = createMockSocket();
    const logger = createMockLogger();
    let proxyHostResolved = null;

    const { proxyConnection } = proxyquire('../lib/proxy-connection', {
        'nodemailer/lib/smtp-connection/http-proxy-client': () => {},
        socks: {
            SocksClient: {
                createConnection: async opts => {
                    proxyHostResolved = opts.proxy.host;
                    return { socket: mockSocket };
                }
            }
        },
        dns: {
            promises: {
                resolve: async hostname => {
                    if (hostname === 'proxy.example.com') {
                        return ['10.0.0.1'];
                    }
                    return ['127.0.0.1'];
                }
            }
        },
        net: { isIP: host => /^\d+\.\d+\.\d+\.\d+$/.test(host) }
    });

    await proxyConnection(logger, 'socks5://proxy.example.com:1080', '192.168.1.1', 993);

    test.equal(proxyHostResolved, '10.0.0.1');
    test.done();
};

// ============================================
// Edge Cases
// ============================================

module.exports['Proxy Connection: Unknown protocol returns undefined'] = async test => {
    const logger = createMockLogger();

    const { proxyConnection } = proxyquire('../lib/proxy-connection', {
        'nodemailer/lib/smtp-connection/http-proxy-client': () => {},
        socks: { SocksClient: {} },
        dns: { promises: { resolve: async () => ['127.0.0.1'] } },
        net: { isIP: () => true }
    });

    const result = await proxyConnection(logger, 'ftp://proxy.example.com:21', '192.168.1.1', 993);

    test.equal(result, undefined);
    test.done();
};

module.exports['Proxy Connection: HTTP proxy with no socket returned'] = async test => {
    const logger = createMockLogger();

    const { proxyConnection } = proxyquire('../lib/proxy-connection', {
        'nodemailer/lib/smtp-connection/http-proxy-client': (url, port, host, cb) => {
            cb(null, null); // No socket
        },
        socks: { SocksClient: {} },
        dns: { promises: { resolve: async () => ['127.0.0.1'] } },
        net: { isIP: () => true }
    });

    const socket = await proxyConnection(logger, 'http://proxy.example.com:8080', '192.168.1.1', 993);

    test.equal(socket, null);
    // No log when socket is null
    test.equal(logger._logs.info.length, 0);
    test.done();
};

module.exports['Proxy Connection: DNS returns empty result'] = async test => {
    const mockSocket = createMockSocket();
    const logger = createMockLogger();
    let usedHost = null;

    const { proxyConnection } = proxyquire('../lib/proxy-connection', {
        'nodemailer/lib/smtp-connection/http-proxy-client': (url, port, host, cb) => {
            usedHost = host;
            cb(null, mockSocket);
        },
        socks: { SocksClient: {} },
        dns: {
            promises: {
                resolve: async () => [] // Empty result
            }
        },
        net: { isIP: () => false }
    });

    await proxyConnection(logger, 'http://proxy.example.com:8080', 'mail.example.com', 993);

    // Should keep original hostname when DNS returns empty
    test.equal(usedHost, 'mail.example.com');
    test.done();
};

module.exports['Proxy Connection: SOCKS with username only'] = async test => {
    const mockSocket = createMockSocket();
    const logger = createMockLogger();

    const { proxyConnection } = proxyquire('../lib/proxy-connection', {
        'nodemailer/lib/smtp-connection/http-proxy-client': () => {},
        socks: {
            SocksClient: {
                createConnection: async opts => {
                    test.equal(opts.proxy.userId, 'testuser');
                    test.equal(opts.proxy.password, ''); // Empty string from URL parsing
                    return { socket: mockSocket };
                }
            }
        },
        dns: { promises: { resolve: async () => ['127.0.0.1'] } },
        net: { isIP: () => true }
    });

    await proxyConnection(logger, 'socks5://testuser@proxy.example.com:1080', '192.168.1.1', 993);
    test.done();
};
