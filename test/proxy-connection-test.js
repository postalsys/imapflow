'use strict';

// Proxy connection tests.
//
// ImapFlow owns HTTP/HTTPS CONNECT negotiation and applies one connection-wide deadline to DNS,
// proxy negotiation and the transport handshake. The DNS policy differs per proxy protocol, so
// these tests pin what each mode is handed:
//   * HTTP/HTTPS - the destination hostname reaches the proxy unresolved
//   * SOCKS4     - destination hostnames are resolved locally to IPv4
//   * SOCKS4a    - destination hostnames are preserved for remote DNS
//   * SOCKS5     - destination hostnames are preserved, IP literals pass through
// and that ImapFlow never resolves a proxy endpoint itself.

const net = require('net');
const { EventEmitter } = require('events');
const proxyquire = require('proxyquire');
const { ConnectionDeadline } = require('../lib/connection-deadline');

// Socket stand-in for the stubbed net/tls connect calls. Tests drive it by emitting 'data'.
const createFakeSocket = () => {
    const socket = new EventEmitter();
    socket.writes = [];
    socket.unshifted = [];
    socket.destroyed = false;
    socket.write = chunk => {
        socket.writes.push(chunk.toString('binary'));
        return true;
    };
    socket.unshift = chunk => socket.unshifted.push(chunk.toString('binary'));
    socket.destroy = () => {
        socket.destroyed = true;
    };
    socket.setTimeout = () => {};
    socket.end = () => {};
    socket.paused = false;
    socket.pause = () => {
        socket.paused = true;
        return socket;
    };
    socket.resume = () => {
        socket.paused = false;
        return socket;
    };
    return socket;
};

// Builds a connect() stub that records its options and hands out fake sockets.
const createConnectStub =
    ({ calls, sockets, autoConnect = true }) =>
    (options, onConnected) => {
        calls.push(options);
        const socket = createFakeSocket();
        sockets.push(socket);
        if (autoConnect) {
            setImmediate(() => onConnected());
        }
        return socket;
    };

// dns stub that fails loudly: no proxy mode may resolve an endpoint through ImapFlow itself.
const createDnsStub = (resolve4Result, onCall) => ({
    promises: {
        resolve4: async hostname => {
            if (onCall) {
                onCall('resolve4', hostname);
            }
            return resolve4Result || [];
        },
        resolve: async hostname => {
            if (onCall) {
                onCall('resolve', hostname);
            }
            return resolve4Result || [];
        }
    }
});

const createMockLogger = () => {
    const logs = { info: [], error: [] };
    return {
        info: msg => logs.info.push(msg),
        error: msg => logs.error.push(msg),
        _logs: logs
    };
};

const tick = () => new Promise(resolve => setImmediate(resolve));

// Loads proxy-connection with stubbed transports. `net` keeps its real address helpers so
// isIP/isIPv6 behave normally.
const loadProxyModule = ({ netConnect, tlsConnect, socksCreateConnection, dnsStub } = {}) =>
    proxyquire('../lib/proxy-connection', {
        net: Object.assign({}, net, netConnect ? { connect: netConnect } : {}),
        tls: tlsConnect ? { connect: tlsConnect } : { connect: () => createFakeSocket() },
        socks: { SocksClient: { createConnection: socksCreateConnection || (async () => ({ socket: createFakeSocket() })) } },
        dns: dnsStub || createDnsStub()
    });

const respondOk = socket => socket.emit('data', Buffer.from('HTTP/1.1 200 Connection established\r\n\r\n'));

// Loads the module with a stubbed transport and returns everything an HTTP CONNECT test needs:
// the recorded connect options, the fake sockets handed out, and a capturing logger. Mirrors
// socksCase() further down.
const httpCase = ({ secureProxy = false, autoConnect = true, dnsStub } = {}) => {
    const calls = [];
    const sockets = [];
    const connectStub = createConnectStub({ calls, sockets, autoConnect });
    const { proxyConnection, detachEarlyErrorHandler } = loadProxyModule({
        [secureProxy ? 'tlsConnect' : 'netConnect']: connectStub,
        dnsStub
    });
    return { proxyConnection, detachEarlyErrorHandler, calls, sockets, logger: createMockLogger() };
};

// ============================================
// HTTP / HTTPS CONNECT
// ============================================

module.exports['Proxy Connection: HTTP CONNECT preserves the destination hostname'] = async test => {
    let dnsCalls = [];
    const { proxyConnection, calls, sockets, logger } = httpCase({
        dnsStub: createDnsStub([], (method, hostname) => dnsCalls.push([method, hostname]))
    });

    const promise = proxyConnection(logger, 'http://proxy.example.com:8080', 'mail.example.com', 993);
    await tick();

    test.deepEqual(calls[0], { host: 'proxy.example.com', port: 8080 }, 'the proxy endpoint hostname is passed unresolved');
    test.ok(sockets[0].writes[0].startsWith('CONNECT mail.example.com:993 HTTP/1.1\r\n'), 'the request line carries the unresolved destination');
    test.ok(sockets[0].writes[0].includes('Host: mail.example.com:993\r\n'), 'the Host header carries the unresolved destination');
    test.deepEqual(dnsCalls, [], 'ImapFlow performs no DNS lookup of its own for an HTTP proxy');

    respondOk(sockets[0]);
    const socket = await promise;

    test.equal(socket, sockets[0], 'the tunnelled socket is returned');
    test.ok(socket.listenerCount('error') >= 1, 'the returned socket carries an early error listener');
    test.equal(logger._logs.info.length, 1);
    test.ok(logger._logs.info[0].msg.includes('HTTP proxy'));
    test.done();
};

module.exports['Proxy Connection: HTTP CONNECT brackets an IPv6 destination'] = async test => {
    const { proxyConnection, sockets, logger } = httpCase();

    const promise = proxyConnection(logger, 'http://proxy.example.com:8080', '2001:db8::5', 993);
    await tick();

    const request = sockets[0].writes[0];
    test.ok(request.startsWith('CONNECT [2001:db8::5]:993 HTTP/1.1\r\n'), 'the request line uses a bracketed authority');
    test.ok(request.includes('Host: [2001:db8::5]:993\r\n'), 'the Host header uses a bracketed authority');

    respondOk(sockets[0]);
    await promise;
    test.done();
};

module.exports['Proxy Connection: HTTP CONNECT does not double-bracket an IPv6 destination'] = async test => {
    const { proxyConnection, sockets, logger } = httpCase();

    const promise = proxyConnection(logger, 'http://proxy.example.com:8080', '[2001:db8::5]', 993);
    await tick();

    test.ok(sockets[0].writes[0].startsWith('CONNECT [2001:db8::5]:993 HTTP/1.1\r\n'), 'an already bracketed literal stays single-bracketed');

    respondOk(sockets[0]);
    await promise;
    test.done();
};

module.exports['Proxy Connection: HTTP proxy endpoint given as an IPv6 URL uses a bare literal'] = async test => {
    const { proxyConnection, calls, sockets, logger } = httpCase();

    const promise = proxyConnection(logger, 'http://[2001:db8::1]:8080', 'mail.example.com', 993);
    await tick();

    test.equal(calls[0].host, '2001:db8::1', 'socket options get the bare literal, not the bracketed URL form');

    respondOk(sockets[0]);
    await promise;

    test.ok(logger._logs.info[0].proxyUrl.includes('[2001:db8::1]'), 'logs keep a valid bracketed URL');
    test.done();
};

module.exports['Proxy Connection: HTTPS proxy sets SNI for a hostname endpoint only'] = async test => {
    let { proxyConnection, calls: hostnameCalls, sockets: hostnameSockets, logger } = httpCase({ secureProxy: true });

    let promise = proxyConnection(logger, 'https://proxy.example.com:8443', 'mail.example.com', 993);
    await tick();

    test.equal(hostnameCalls[0].servername, 'proxy.example.com', 'SNI and hostname verification target the proxy, not the IMAP destination');
    respondOk(hostnameSockets[0]);
    await promise;

    let { proxyConnection: connectViaLiteral, calls: literalCalls, sockets: literalSockets } = httpCase({ secureProxy: true });
    promise = connectViaLiteral(logger, 'https://10.0.0.1:8443', 'mail.example.com', 993);
    await tick();

    test.equal(literalCalls[0].servername, undefined, 'an IP-literal endpoint gets no servername');
    test.equal(literalCalls[0].host, '10.0.0.1');
    respondOk(literalSockets[0]);
    await promise;

    test.done();
};

module.exports['Proxy Connection: HTTP CONNECT sends Basic credentials and keeps them out of logs'] = async test => {
    const { proxyConnection, sockets, logger } = httpCase();

    const promise = proxyConnection(logger, 'http://user:secret123@proxy.example.com:8080', 'mail.example.com', 993);
    await tick();

    const request = sockets[0].writes[0];
    const authHeader = request.match(/Proxy-Authorization: Basic (\S+)/);
    test.ok(authHeader, 'credentials are sent in the Proxy-Authorization header');
    test.equal(Buffer.from(authHeader[1], 'base64').toString(), 'user:secret123');
    test.ok(!request.includes('secret123'), 'credentials appear only base64 encoded, never in clear text');

    respondOk(sockets[0]);
    await promise;

    test.ok(!logger._logs.info[0].proxyUrl.includes('secret123'), 'the success log is redacted');
    test.ok(logger._logs.info[0].proxyUrl.includes('(hidden)'));
    test.done();
};

module.exports['Proxy Connection: HTTP CONNECT rejects a non-2xx response and redacts the log'] = async test => {
    const { proxyConnection, sockets, logger } = httpCase();

    const promise = proxyConnection(logger, 'http://user:secret123@proxy.example.com:8080', 'mail.example.com', 993);
    await tick();
    sockets[0].emit('data', Buffer.from('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'));

    let err = await promise.then(() => null).catch(e => e);
    test.ok(err, 'a refused CONNECT rejects');
    test.equal(err.code, 'EPROXY');
    test.ok(/407/.test(err.message), 'the status code is reported');
    test.ok(sockets[0].destroyed, 'the socket is destroyed');
    test.ok(!logger._logs.error[0].proxyUrl.includes('secret123'), 'the failure log is redacted');
    test.ok(logger._logs.error[0].proxyUrl.includes('(hidden)'));
    test.done();
};

module.exports['Proxy Connection: HTTP CONNECT bounds the response header buffer'] = async test => {
    const { proxyConnection, sockets, logger } = httpCase();

    const promise = proxyConnection(logger, 'http://proxy.example.com:8080', 'mail.example.com', 993);
    await tick();

    // A proxy that never sends the header terminator must not grow memory without bound
    for (let i = 0; i < 10 && !sockets[0].destroyed; i++) {
        sockets[0].emit('data', Buffer.alloc(16 * 1024, 0x41));
    }

    let err = await promise.then(() => null).catch(e => e);
    test.ok(err, 'the oversized header response rejects');
    test.equal(err.code, 'EPROXY');
    test.ok(/headers too large/i.test(err.message));
    test.ok(sockets[0].destroyed, 'the socket is destroyed');
    test.done();
};

module.exports['Proxy Connection: HTTP CONNECT preserves bytes after the header terminator'] = async test => {
    const { proxyConnection, sockets, logger } = httpCase();

    const promise = proxyConnection(logger, 'http://proxy.example.com:8080', 'mail.example.com', 993);
    await tick();

    // The destination greeting arrives in the same segment as the CONNECT response
    sockets[0].emit('data', Buffer.from('HTTP/1.1 200 OK\r\n\r\n* OK [CAPABILITY IMAP4rev1] ready\r\n'));

    const socket = await promise;
    test.deepEqual(socket.unshifted, ['* OK [CAPABILITY IMAP4rev1] ready\r\n'], 'trailing bytes are pushed back for the next consumer');
    test.done();
};

module.exports['Proxy Connection: HTTP CONNECT rejects a destination with CRLF'] = async test => {
    const { proxyConnection, calls, logger } = httpCase();

    let err = await proxyConnection(logger, 'http://proxy.example.com:8080', 'mail.example.com\r\nX-Injected: 1', 993)
        .then(() => null)
        .catch(e => e);

    test.ok(err, 'header injection through the destination is rejected');
    test.equal(err.code, 'EPROXY');
    test.deepEqual(calls, [], 'no socket is opened for an invalid destination');
    test.done();
};

module.exports['Proxy Connection: HTTP CONNECT rejects an invalid destination port'] = async test => {
    const { proxyConnection, logger } = httpCase();

    let err = await proxyConnection(logger, 'http://proxy.example.com:8080', 'mail.example.com', 0)
        .then(() => null)
        .catch(e => e);

    test.ok(err, 'a missing destination port is rejected');
    test.equal(err.code, 'EPROXY');
    test.done();
};

module.exports['Proxy Connection: an early socket close rejects the tunnel'] = async test => {
    const { proxyConnection, sockets, logger } = httpCase();

    const promise = proxyConnection(logger, 'http://proxy.example.com:8080', 'mail.example.com', 993);
    await tick();
    sockets[0].emit('close');

    let err = await promise.then(() => null).catch(e => e);
    test.ok(err, 'a proxy that hangs up before responding rejects');
    test.equal(err.code, 'EPROXY');
    test.done();
};

module.exports['Proxy Connection: a late socket event cannot settle the tunnel twice'] = async test => {
    const { proxyConnection, sockets, logger } = httpCase();

    const promise = proxyConnection(logger, 'http://proxy.example.com:8080', 'mail.example.com', 993);
    await tick();
    respondOk(sockets[0]);
    const socket = await promise;

    // Late events after settlement: the temporary listeners are gone, so nothing re-settles and
    // nothing throws. Only the early error guard remains.
    test.equal(socket.listenerCount('close'), 0, 'the temporary close listener was removed');
    test.doesNotThrow(() => socket.emit('error', new Error('late error')), 'a late error is absorbed by the early error guard');
    test.doesNotThrow(() => socket.emit('data', Buffer.from('HTTP/1.1 500 late\r\n\r\n')), 'late data is no longer parsed as a CONNECT response');
    test.equal(logger._logs.error.length, 1, 'the late error was logged once by the early guard, not reported as a proxy failure');
    test.done();
};

// ============================================
// Connection deadline
// ============================================

module.exports['Proxy Connection: HTTP CONNECT timeout destroys the in-flight socket'] = async test => {
    const { proxyConnection, sockets, logger } = httpCase();

    // The proxy accepts the connection and never answers the CONNECT request
    const promise = proxyConnection(logger, 'http://proxy.example.com:8080', 'mail.example.com', 993, { connectionTimeout: 60 });

    let err = await promise.then(() => null).catch(e => e);
    test.ok(err, 'the stalled CONNECT rejects');
    test.equal(err.code, 'CONNECT_TIMEOUT', 'a proxy phase expiry uses the shared connection timeout code');
    test.equal(err.details.connectionTimeout, 60, 'the configured timeout is reported');
    test.ok(sockets[0].destroyed, 'the in-flight socket is destroyed immediately');
    test.done();
};

module.exports['Proxy Connection: a stalled endpoint connection still hits the deadline'] = async test => {
    // autoConnect false: the dependency-level connection never completes
    const { proxyConnection, sockets, logger } = httpCase({ autoConnect: false });

    let err = await proxyConnection(logger, 'http://proxy.example.com:8080', 'mail.example.com', 993, { connectionTimeout: 60 })
        .then(() => null)
        .catch(e => e);

    test.ok(err, 'a connection that never establishes rejects');
    test.equal(err.code, 'CONNECT_TIMEOUT');
    test.ok(sockets[0].destroyed, 'the shared deadline destroys the stalled socket');
    test.done();
};

module.exports['Proxy Connection: concurrent HTTP deadlines are independent'] = async test => {
    const { proxyConnection, sockets, logger } = httpCase();

    // A short-deadline connection that stalls and a long-deadline connection that succeeds
    const stalled = proxyConnection(logger, 'http://proxy.example.com:8080', 'stalled.example.com', 993, { connectionTimeout: 60 })
        .then(() => null)
        .catch(e => e);
    const healthy = proxyConnection(logger, 'http://proxy.example.com:8080', 'healthy.example.com', 993, { connectionTimeout: 5000 });

    await tick();
    test.equal(sockets.length, 2, 'both connections opened their own socket');

    let err = await stalled;
    test.equal(err.code, 'CONNECT_TIMEOUT', 'the short deadline expired on its own connection');
    test.ok(sockets[0].destroyed, 'only the stalled socket was destroyed');
    test.ok(!sockets[1].destroyed, 'the other connection is untouched by the expired deadline');

    respondOk(sockets[1]);
    const socket = await healthy;
    test.equal(socket, sockets[1], 'the longer deadline still completes normally');
    test.done();
};

module.exports['Proxy Connection: an exhausted deadline rejects before any work starts'] = async test => {
    const { proxyConnection, calls, logger } = httpCase();

    const deadline = new ConnectionDeadline(50);
    await new Promise(resolve => setTimeout(resolve, 80));

    let err = await proxyConnection(logger, 'http://proxy.example.com:8080', 'mail.example.com', 993, { deadline })
        .then(() => null)
        .catch(e => e);

    test.ok(err, 'no phase is started once the budget is gone');
    test.equal(err.code, 'CONNECT_TIMEOUT');
    test.deepEqual(calls, [], 'no socket was opened');
    test.done();
};

// ============================================
// SOCKS
// ============================================

const socksCase = async ({ proxyUrl, host, port = 993, resolve4Result, dnsCalls }) => {
    const options = [];
    const logger = createMockLogger();
    const socket = createFakeSocket();

    const { proxyConnection } = loadProxyModule({
        socksCreateConnection: async opts => {
            options.push(opts);
            return { socket };
        },
        dnsStub: createDnsStub(resolve4Result, dnsCalls ? (method, hostname) => dnsCalls.push([method, hostname]) : null)
    });

    const result = await proxyConnection(logger, proxyUrl, host, port).then(
        value => ({ value }),
        err => ({ err })
    );

    return { options, logger, socket, result };
};

module.exports['Proxy Connection: SOCKS5 preserves the destination hostname for remote DNS'] = async test => {
    const dnsCalls = [];
    const { options, result } = await socksCase({ proxyUrl: 'socks5://proxy.example.com:1080', host: 'mail.example.com', dnsCalls });

    test.equal(options[0].proxy.type, 5);
    test.equal(options[0].proxy.host, 'proxy.example.com', 'the endpoint hostname reaches the dependency unresolved');
    test.equal(options[0].destination.host, 'mail.example.com', 'the destination hostname is left for the proxy to resolve');
    test.equal(options[0].command, 'connect');
    test.ok(options[0].timeout > 0, 'a strictly positive timeout is passed, never zero');
    test.deepEqual(dnsCalls, [], 'ImapFlow resolves nothing for SOCKS5');
    test.ok(result.value, 'the socket is returned');
    test.done();
};

module.exports['Proxy Connection: SOCKS (alias) defaults to SOCKS5'] = async test => {
    const { options } = await socksCase({ proxyUrl: 'socks://proxy.example.com:1080', host: 'mail.example.com' });
    test.equal(options[0].proxy.type, 5);
    test.equal(options[0].destination.host, 'mail.example.com');
    test.done();
};

module.exports['Proxy Connection: SOCKS5 passes IP literals through unchanged'] = async test => {
    let { options } = await socksCase({ proxyUrl: 'socks5://proxy.example.com:1080', host: '192.168.1.1' });
    test.equal(options[0].destination.host, '192.168.1.1', 'IPv4 literal unchanged');

    ({ options } = await socksCase({ proxyUrl: 'socks5://proxy.example.com:1080', host: '2001:db8::9' }));
    test.equal(options[0].destination.host, '2001:db8::9', 'IPv6 literal unchanged');
    test.done();
};

module.exports['Proxy Connection: SOCKS4a preserves the destination hostname for remote DNS'] = async test => {
    const dnsCalls = [];
    const { options } = await socksCase({ proxyUrl: 'socks4a://proxy.example.com:1080', host: 'mail.example.com', dnsCalls });

    test.equal(options[0].proxy.type, 4, 'the dependency uses proxy type 4 for both SOCKS4 and SOCKS4a');
    test.equal(options[0].destination.host, 'mail.example.com', 'the hostname is preserved so the proxy resolves it');
    test.deepEqual(dnsCalls, [], 'no local lookup for SOCKS4a');
    test.done();
};

module.exports['Proxy Connection: SOCKS4 resolves the destination locally to IPv4'] = async test => {
    const dnsCalls = [];
    const { options } = await socksCase({
        proxyUrl: 'socks4://proxy.example.com:1080',
        host: 'mail.example.com',
        resolve4Result: ['93.184.216.34'],
        dnsCalls
    });

    test.equal(options[0].proxy.type, 4);
    test.equal(options[0].destination.host, '93.184.216.34', 'SOCKS4 gets a resolved IPv4 address, not a hostname');
    test.deepEqual(dnsCalls, [['resolve4', 'mail.example.com']], 'the lookup is explicitly IPv4 only');
    test.done();
};

module.exports['Proxy Connection: SOCKS4 reports an unresolvable destination'] = async test => {
    const { result } = await socksCase({
        proxyUrl: 'socks4://proxy.example.com:1080',
        host: 'mail.example.com',
        resolve4Result: []
    });

    test.ok(result.err, 'an empty IPv4 lookup fails the connection');
    test.equal(result.err.code, 'EPROXY');
    test.done();
};

module.exports['Proxy Connection: SOCKS4 and SOCKS4a reject IPv6 destinations clearly'] = async test => {
    for (let proxyUrl of ['socks4://proxy.example.com:1080', 'socks4a://proxy.example.com:1080']) {
        const { options, result, logger } = await socksCase({ proxyUrl, host: '2001:db8::9' });

        test.ok(result.err, `${proxyUrl} rejects an IPv6 destination`);
        test.equal(result.err.code, 'UnsupportedProxyAddress', 'the failure names the unsupported address type');
        test.deepEqual(options, [], 'no request is emitted with the address in the wrong field');
        test.equal(logger._logs.error.length, 1, 'the failure is logged');
    }
    test.done();
};

module.exports['Proxy Connection: bracketed IPv6 proxy URL yields a bare literal endpoint'] = async test => {
    const { options, logger } = await socksCase({ proxyUrl: 'socks5://[2001:db8::1]:1080', host: 'mail.example.com' });

    test.equal(options[0].proxy.host, '2001:db8::1', 'brackets are stripped before the address reaches the dependency');
    test.ok(logger._logs.info[0].proxyUrl.includes('[2001:db8::1]'), 'logs keep a valid bracketed URL');
    test.done();
};

module.exports['Proxy Connection: SOCKS passes credentials and hides them in logs'] = async test => {
    const { options, logger } = await socksCase({ proxyUrl: 'socks5://testuser:testpass@proxy.example.com:1080', host: 'mail.example.com' });

    test.equal(options[0].proxy.userId, 'testuser');
    test.equal(options[0].proxy.password, 'testpass');
    test.ok(!logger._logs.info[0].proxyUrl.includes('testpass'));
    test.ok(logger._logs.info[0].proxyUrl.includes('(hidden)'));
    test.done();
};

module.exports['Proxy Connection: SOCKS with username only'] = async test => {
    const { options } = await socksCase({ proxyUrl: 'socks5://testuser@proxy.example.com:1080', host: 'mail.example.com' });
    test.equal(options[0].proxy.userId, 'testuser');
    test.equal(options[0].proxy.password, '', 'empty string from URL parsing');
    test.done();
};

module.exports['Proxy Connection: SOCKS default port'] = async test => {
    const { options } = await socksCase({ proxyUrl: 'socks5://proxy.example.com', host: 'mail.example.com' });
    test.equal(options[0].proxy.port, 1080);
    test.done();
};

module.exports['Proxy Connection: SOCKS failure is reported and redacted'] = async test => {
    const logger = createMockLogger();
    const testError = new Error('SOCKS connection failed');

    const { proxyConnection } = loadProxyModule({
        socksCreateConnection: async () => {
            throw testError;
        }
    });

    let err = await proxyConnection(logger, 'socks5://user:secret@proxy.example.com:1080', 'mail.example.com', 993)
        .then(() => null)
        .catch(e => e);

    test.equal(err, testError, 'the dependency error is preserved');
    test.equal(logger._logs.error.length, 1);
    test.ok(!logger._logs.error[0].proxyUrl.includes('secret'));
    test.ok(logger._logs.error[0].proxyUrl.includes('(hidden)'));
    test.done();
};

module.exports['Proxy Connection: SOCKS returning no socket fails'] = async test => {
    const logger = createMockLogger();

    const { proxyConnection } = loadProxyModule({ socksCreateConnection: async () => ({}) });

    let err = await proxyConnection(logger, 'socks5://proxy.example.com:1080', 'mail.example.com', 993)
        .then(() => null)
        .catch(e => e);

    test.ok(err, 'a missing socket is an error rather than an undefined return');
    test.equal(err.code, 'EPROXY');
    test.done();
};

module.exports['Proxy Connection: the SOCKS dependency timeout is normalized to CONNECT_TIMEOUT'] = async test => {
    const logger = createMockLogger();

    const { proxyConnection } = loadProxyModule({
        socksCreateConnection: async () => {
            // the shape the socks client uses for its own expiry
            throw new Error('Proxy connection timed out');
        }
    });

    let err = await proxyConnection(logger, 'socks5://proxy.example.com:1080', 'mail.example.com', 993, { connectionTimeout: 5000 })
        .then(() => null)
        .catch(e => e);

    test.equal(err.code, 'CONNECT_TIMEOUT', 'SOCKS and HTTP expose the same timeout code');
    test.equal(err.details.connectionTimeout, 5000, 'the normalized error carries the configured timeout');
    test.ok(err._err, 'the dependency error is kept for diagnostics');
    test.done();
};

module.exports['Proxy Connection: a stalled SOCKS negotiation hits the shared deadline'] = async test => {
    const logger = createMockLogger();

    const { proxyConnection } = loadProxyModule({
        socksCreateConnection: () => new Promise(() => {}) // never settles
    });

    let err = await proxyConnection(logger, 'socks5://proxy.example.com:1080', 'mail.example.com', 993, { connectionTimeout: 60 })
        .then(() => null)
        .catch(e => e);

    test.equal(err.code, 'CONNECT_TIMEOUT', 'the shared deadline bounds the dependency');
    test.done();
};

module.exports['Proxy Connection: SOCKS4 local lookup runs inside the deadline'] = async test => {
    const logger = createMockLogger();

    const { proxyConnection } = loadProxyModule({
        socksCreateConnection: async () => ({ socket: createFakeSocket() }),
        dnsStub: { promises: { resolve4: () => new Promise(() => {}), resolve: () => new Promise(() => {}) } }
    });

    let err = await proxyConnection(logger, 'socks4://proxy.example.com:1080', 'mail.example.com', 993, { connectionTimeout: 60 })
        .then(() => null)
        .catch(e => e);

    test.equal(err.code, 'CONNECT_TIMEOUT', 'a stalled DNS lookup cannot outlive the connection timeout');
    test.done();
};

// ============================================
// Edge cases
// ============================================

module.exports['Proxy Connection: Unknown protocol returns undefined'] = async test => {
    const logger = createMockLogger();
    const { proxyConnection } = loadProxyModule({});

    const result = await proxyConnection(logger, 'ftp://proxy.example.com:21', 'mail.example.com', 993);

    test.equal(result, undefined);
    test.done();
};

module.exports['Proxy Connection: detachEarlyErrorHandler removes the early guard'] = async test => {
    const { proxyConnection, detachEarlyErrorHandler, sockets, logger } = httpCase();

    const promise = proxyConnection(logger, 'http://proxy.example.com:8080', 'mail.example.com', 993);
    await tick();
    respondOk(sockets[0]);
    const socket = await promise;

    test.ok(socket.listenerCount('error') >= 1, 'early error handler attached on return');
    test.ok(typeof socket._earlyErrorHandler === 'function', 'handler reference stored on the socket');

    detachEarlyErrorHandler(socket);

    test.equal(socket.listenerCount('error'), 0, 'early error handler removed after detach');
    test.equal(socket._earlyErrorHandler, null, 'stored handler reference cleared');

    // Detaching again (or on a bare socket) must be a safe no-op.
    test.doesNotThrow(() => detachEarlyErrorHandler(socket));
    test.doesNotThrow(() => detachEarlyErrorHandler(createFakeSocket()));

    test.done();
};

module.exports['Proxy Connection: socket without .on skips early error handler attach'] = async test => {
    const logger = createMockLogger();
    const { proxyConnection } = loadProxyModule({ socksCreateConnection: async () => ({ socket: { write() {} } }) });

    const socket = await proxyConnection(logger, 'socks5://proxy.example.com:1080', 'mail.example.com', 993);

    test.ok(socket, 'a socket-like object without an event emitter interface is still returned');
    test.equal(socket._earlyErrorHandler, undefined, 'no handler is attached to it');
    test.done();
};

// ============================================
// Credential handling and malformed userinfo
// ============================================

module.exports['Proxy Connection: a proxy password with a bare percent sign still connects'] = async test => {
    // URL userinfo is percent-encoded, so a bare '%' is not valid encoding. Decoding it must not
    // throw out of the connect callback, which would both crash the process and leave the
    // connection promise pending forever.
    const { proxyConnection, sockets, logger } = httpCase();

    const promise = proxyConnection(logger, 'http://user:p%ss@proxy.example.com:8080', 'mail.example.com', 993);
    await tick();

    const authHeader = sockets[0].writes[0].match(/Proxy-Authorization: Basic (\S+)/);
    test.ok(authHeader, 'credentials are still sent');
    test.equal(Buffer.from(authHeader[1], 'base64').toString(), 'user:p%ss', 'the undecodable value is used as it came in');

    respondOk(sockets[0]);
    const socket = await promise;
    test.ok(socket, 'the tunnel is established');
    test.done();
};

module.exports['Proxy Connection: a SOCKS failure never carries the proxy password'] = async test => {
    // The socks client attaches its full options object - password included - to the errors it
    // throws, and a logger that serializes error properties would write it out in clear text.
    const logger = createMockLogger();

    const { proxyConnection } = loadProxyModule({
        socksCreateConnection: async opts => {
            let err = new Error('Socks5 proxy rejected connection - Failure');
            err.options = opts; // this is what socks does
            throw err;
        }
    });

    let err = await proxyConnection(logger, 'socks5://user:secretpass@proxy.example.com:1080', 'mail.example.com', 993)
        .then(() => null)
        .catch(e => e);

    test.ok(err, 'the failure still propagates');
    test.equal(err.options, undefined, 'the credential-bearing options object is stripped from the error');
    test.ok(!JSON.stringify(logger._logs.error).includes('secretpass'), 'the password does not reach the log');
    test.done();
};

module.exports['Proxy Connection: a normalized SOCKS timeout carries no credentials either'] = async test => {
    const logger = createMockLogger();

    const { proxyConnection } = loadProxyModule({
        socksCreateConnection: async opts => {
            let err = new Error('Proxy connection timed out');
            err.options = opts;
            throw err;
        }
    });

    let err = await proxyConnection(logger, 'socks5://user:secretpass@proxy.example.com:1080', 'mail.example.com', 993, { connectionTimeout: 5000 })
        .then(() => null)
        .catch(e => e);

    test.equal(err.code, 'CONNECT_TIMEOUT');
    test.equal(err._err.options, undefined, 'the retained diagnostic error is stripped too');
    test.ok(!JSON.stringify(logger._logs.error).includes('secretpass'), 'the password does not reach the log');
    test.done();
};
