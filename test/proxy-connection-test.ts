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
//
// The transports are stubbed in place with node:test mocks on the real module objects
// (net.connect, tls.connect, SocksClient.createConnection, dns.promises): the module under
// test reads them at call time, so a mock installed for the duration of a test is what it uses.

import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import { EventEmitter } from 'node:events';
import { SocksClient } from 'socks';
import { ConnectionDeadline } from '../src/connection-deadline.js';
import { proxyConnection, detachEarlyErrorHandler } from '../src/proxy-connection.js';

// Socket stand-in for the stubbed net/tls connect calls. Tests drive it by emitting 'data'.
const createFakeSocket = (): any => {
    const socket: any = new EventEmitter();
    socket.writes = [];
    socket.unshifted = [];
    socket.destroyed = false;
    socket.write = (chunk: Buffer | string) => {
        socket.writes.push(chunk.toString('binary'));
        return true;
    };
    socket.unshift = (chunk: Buffer) => socket.unshifted.push(chunk.toString('binary'));
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
    ({ calls, sockets, autoConnect = true }: { calls: any[]; sockets: any[]; autoConnect?: boolean }) =>
    (options: any, onConnected: () => void) => {
        calls.push(options);
        const socket = createFakeSocket();
        sockets.push(socket);
        if (autoConnect) {
            setImmediate(() => onConnected());
        }
        return socket;
    };

type DnsStub = { resolve4: (hostname: string) => Promise<string[]>; resolve: (hostname: string) => Promise<string[]> };

// dns stub that fails loudly: no proxy mode may resolve an endpoint through ImapFlow itself.
const createDnsStub = (resolve4Result?: string[], onCall?: ((method: string, hostname: string) => void) | null): DnsStub => ({
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
});

const createMockLogger = () => {
    const logs: { info: any[]; error: any[] } = { info: [], error: [] };
    return {
        info: (msg: any) => logs.info.push(msg),
        error: (msg: any) => logs.error.push(msg),
        _logs: logs
    };
};

const tick = () => new Promise(resolve => setImmediate(resolve));

interface StubOptions {
    netConnect?: (...args: any[]) => any;
    tlsConnect?: (...args: any[]) => any;
    socksCreateConnection?: (...args: any[]) => any;
    dnsStub?: DnsStub;
}

// Installs the transport stubs for the current test. `net` keeps its real address helpers so
// isIP/isIPv6 behave normally; only connect() is replaced, and only when a stub is given. The
// mocks are dropped again when the test finishes (and at the start of a re-install within one
// test, so a helper can be called more than once).
const stubTransports = (t: TestContext, { netConnect, tlsConnect, socksCreateConnection, dnsStub }: StubOptions = {}) => {
    t.mock.restoreAll();
    t.after(() => t.mock.restoreAll());
    if (netConnect) {
        t.mock.method(net, 'connect', netConnect as any);
    }
    t.mock.method(tls, 'connect', (tlsConnect || (() => createFakeSocket())) as any);
    t.mock.method(SocksClient, 'createConnection', (socksCreateConnection || (async () => ({ socket: createFakeSocket() }))) as any);
    const dnsImpl = dnsStub || createDnsStub();
    t.mock.method(dns.promises, 'resolve4', dnsImpl.resolve4 as any);
    t.mock.method(dns.promises, 'resolve', dnsImpl.resolve as any);
    return { proxyConnection, detachEarlyErrorHandler };
};

const respondOk = (socket: any) => socket.emit('data', Buffer.from('HTTP/1.1 200 Connection established\r\n\r\n'));

// Stubs the transport and returns everything an HTTP CONNECT test needs: the recorded connect
// options, the fake sockets handed out, and a capturing logger. Mirrors socksCase() further down.
const httpCase = (
    t: TestContext,
    { secureProxy = false, autoConnect = true, dnsStub }: { secureProxy?: boolean; autoConnect?: boolean; dnsStub?: DnsStub } = {}
) => {
    const calls: any[] = [];
    const sockets: any[] = [];
    const connectStub = createConnectStub({ calls, sockets, autoConnect });
    const { proxyConnection, detachEarlyErrorHandler } = stubTransports(t, {
        [secureProxy ? 'tlsConnect' : 'netConnect']: connectStub,
        dnsStub
    } as any);
    return { proxyConnection, detachEarlyErrorHandler, calls, sockets, logger: createMockLogger() };
};

const socksCase = async (
    t: TestContext,
    { proxyUrl, host, port = 993, resolve4Result, dnsCalls }: { proxyUrl: string; host: string; port?: number; resolve4Result?: string[]; dnsCalls?: any[] }
) => {
    const options: any[] = [];
    const logger = createMockLogger();
    const socket = createFakeSocket();

    const { proxyConnection } = stubTransports(t, {
        socksCreateConnection: async (opts: any) => {
            options.push(opts);
            return { socket };
        },
        dnsStub: createDnsStub(resolve4Result, dnsCalls ? (method, hostname) => dnsCalls.push([method, hostname]) : null)
    });

    const result: any = await proxyConnection(logger as any, proxyUrl, host, port).then(
        value => ({ value }),
        err => ({ err })
    );

    return { options, logger, socket, result };
};

describe('proxy-connection', () => {
    // ============================================
    // HTTP / HTTPS CONNECT
    // ============================================

    it('Proxy Connection: HTTP CONNECT preserves the destination hostname', async t => {
        let dnsCalls: any[] = [];
        const { proxyConnection, calls, sockets, logger } = httpCase(t, {
            dnsStub: createDnsStub([], (method, hostname) => dnsCalls.push([method, hostname]))
        });

        const promise = proxyConnection(logger as any, 'http://proxy.example.com:8080', 'mail.example.com', 993);
        await tick();

        assert.deepEqual(calls[0], { host: 'proxy.example.com', port: 8080 }, 'the proxy endpoint hostname is passed unresolved');
        assert.ok(sockets[0].writes[0].startsWith('CONNECT mail.example.com:993 HTTP/1.1\r\n'), 'the request line carries the unresolved destination');
        assert.ok(sockets[0].writes[0].includes('Host: mail.example.com:993\r\n'), 'the Host header carries the unresolved destination');
        assert.deepEqual(dnsCalls, [], 'ImapFlow performs no DNS lookup of its own for an HTTP proxy');

        respondOk(sockets[0]);
        const socket: any = await promise;

        assert.equal(socket, sockets[0], 'the tunnelled socket is returned');
        assert.ok(socket.listenerCount('error') >= 1, 'the returned socket carries an early error listener');
        assert.equal(logger._logs.info.length, 1);
        assert.ok(logger._logs.info[0].msg.includes('HTTP proxy'));
    });

    it('Proxy Connection: HTTP CONNECT brackets an IPv6 destination', async t => {
        const { proxyConnection, sockets, logger } = httpCase(t);

        const promise = proxyConnection(logger as any, 'http://proxy.example.com:8080', '2001:db8::5', 993);
        await tick();

        const request = sockets[0].writes[0];
        assert.ok(request.startsWith('CONNECT [2001:db8::5]:993 HTTP/1.1\r\n'), 'the request line uses a bracketed authority');
        assert.ok(request.includes('Host: [2001:db8::5]:993\r\n'), 'the Host header uses a bracketed authority');

        respondOk(sockets[0]);
        await promise;
    });

    it('Proxy Connection: HTTP CONNECT does not double-bracket an IPv6 destination', async t => {
        const { proxyConnection, sockets, logger } = httpCase(t);

        const promise = proxyConnection(logger as any, 'http://proxy.example.com:8080', '[2001:db8::5]', 993);
        await tick();

        assert.ok(sockets[0].writes[0].startsWith('CONNECT [2001:db8::5]:993 HTTP/1.1\r\n'), 'an already bracketed literal stays single-bracketed');

        respondOk(sockets[0]);
        await promise;
    });

    it('Proxy Connection: HTTP proxy endpoint given as an IPv6 URL uses a bare literal', async t => {
        const { proxyConnection, calls, sockets, logger } = httpCase(t);

        const promise = proxyConnection(logger as any, 'http://[2001:db8::1]:8080', 'mail.example.com', 993);
        await tick();

        assert.equal(calls[0].host, '2001:db8::1', 'socket options get the bare literal, not the bracketed URL form');

        respondOk(sockets[0]);
        await promise;

        assert.ok(logger._logs.info[0].proxyUrl.includes('[2001:db8::1]'), 'logs keep a valid bracketed URL');
    });

    it('Proxy Connection: HTTPS proxy sets SNI for a hostname endpoint only', async t => {
        let { proxyConnection, calls: hostnameCalls, sockets: hostnameSockets, logger } = httpCase(t, { secureProxy: true });

        let promise = proxyConnection(logger as any, 'https://proxy.example.com:8443', 'mail.example.com', 993);
        await tick();

        assert.equal(hostnameCalls[0].servername, 'proxy.example.com', 'SNI and hostname verification target the proxy, not the IMAP destination');
        respondOk(hostnameSockets[0]);
        await promise;

        let { proxyConnection: connectViaLiteral, calls: literalCalls, sockets: literalSockets } = httpCase(t, { secureProxy: true });
        promise = connectViaLiteral(logger as any, 'https://10.0.0.1:8443', 'mail.example.com', 993);
        await tick();

        assert.equal(literalCalls[0].servername, undefined, 'an IP-literal endpoint gets no servername');
        assert.equal(literalCalls[0].host, '10.0.0.1');
        respondOk(literalSockets[0]);
        await promise;
    });

    it('Proxy Connection: HTTP CONNECT sends Basic credentials and keeps them out of logs', async t => {
        const { proxyConnection, sockets, logger } = httpCase(t);

        const promise = proxyConnection(logger as any, 'http://user:secret123@proxy.example.com:8080', 'mail.example.com', 993);
        await tick();

        const request = sockets[0].writes[0];
        const authHeader = request.match(/Proxy-Authorization: Basic (\S+)/);
        assert.ok(authHeader, 'credentials are sent in the Proxy-Authorization header');
        assert.equal(Buffer.from(authHeader[1], 'base64').toString(), 'user:secret123');
        assert.ok(!request.includes('secret123'), 'credentials appear only base64 encoded, never in clear text');

        respondOk(sockets[0]);
        await promise;

        assert.ok(!logger._logs.info[0].proxyUrl.includes('secret123'), 'the success log is redacted');
        assert.ok(logger._logs.info[0].proxyUrl.includes('(hidden)'));
    });

    it('Proxy Connection: HTTP CONNECT rejects a non-2xx response and redacts the log', async t => {
        const { proxyConnection, sockets, logger } = httpCase(t);

        const promise = proxyConnection(logger as any, 'http://user:secret123@proxy.example.com:8080', 'mail.example.com', 993);
        await tick();
        sockets[0].emit('data', Buffer.from('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'));

        let err: any = await promise.then(() => null).catch(e => e);
        assert.ok(err, 'a refused CONNECT rejects');
        assert.equal(err.code, 'EPROXY');
        assert.ok(/407/.test(err.message), 'the status code is reported');
        assert.ok(sockets[0].destroyed, 'the socket is destroyed');
        assert.ok(!logger._logs.error[0].proxyUrl.includes('secret123'), 'the failure log is redacted');
        assert.ok(logger._logs.error[0].proxyUrl.includes('(hidden)'));
    });

    it('Proxy Connection: HTTP CONNECT bounds the response header buffer', async t => {
        const { proxyConnection, sockets, logger } = httpCase(t);

        const promise = proxyConnection(logger as any, 'http://proxy.example.com:8080', 'mail.example.com', 993);
        await tick();

        // A proxy that never sends the header terminator must not grow memory without bound
        for (let i = 0; i < 10 && !sockets[0].destroyed; i++) {
            sockets[0].emit('data', Buffer.alloc(16 * 1024, 0x41));
        }

        let err: any = await promise.then(() => null).catch(e => e);
        assert.ok(err, 'the oversized header response rejects');
        assert.equal(err.code, 'EPROXY');
        assert.ok(/headers too large/i.test(err.message));
        assert.ok(sockets[0].destroyed, 'the socket is destroyed');
    });

    it('Proxy Connection: HTTP CONNECT preserves bytes after the header terminator', async t => {
        const { proxyConnection, sockets, logger } = httpCase(t);

        const promise = proxyConnection(logger as any, 'http://proxy.example.com:8080', 'mail.example.com', 993);
        await tick();

        // The destination greeting arrives in the same segment as the CONNECT response
        sockets[0].emit('data', Buffer.from('HTTP/1.1 200 OK\r\n\r\n* OK [CAPABILITY IMAP4rev1] ready\r\n'));

        const socket: any = await promise;
        assert.deepEqual(socket.unshifted, ['* OK [CAPABILITY IMAP4rev1] ready\r\n'], 'trailing bytes are pushed back for the next consumer');
    });

    it('Proxy Connection: HTTP CONNECT rejects a destination with CRLF', async t => {
        const { proxyConnection, calls, logger } = httpCase(t);

        let err: any = await proxyConnection(logger as any, 'http://proxy.example.com:8080', 'mail.example.com\r\nX-Injected: 1', 993)
            .then(() => null)
            .catch(e => e);

        assert.ok(err, 'header injection through the destination is rejected');
        assert.equal(err.code, 'EPROXY');
        assert.deepEqual(calls, [], 'no socket is opened for an invalid destination');
    });

    it('Proxy Connection: HTTP CONNECT rejects an invalid destination port', async t => {
        const { proxyConnection, logger } = httpCase(t);

        let err: any = await proxyConnection(logger as any, 'http://proxy.example.com:8080', 'mail.example.com', 0)
            .then(() => null)
            .catch(e => e);

        assert.ok(err, 'a missing destination port is rejected');
        assert.equal(err.code, 'EPROXY');
    });

    it('Proxy Connection: an early socket close rejects the tunnel', async t => {
        const { proxyConnection, sockets, logger } = httpCase(t);

        const promise = proxyConnection(logger as any, 'http://proxy.example.com:8080', 'mail.example.com', 993);
        await tick();
        sockets[0].emit('close');

        let err: any = await promise.then(() => null).catch(e => e);
        assert.ok(err, 'a proxy that hangs up before responding rejects');
        assert.equal(err.code, 'EPROXY');
    });

    it('Proxy Connection: a late socket event cannot settle the tunnel twice', async t => {
        const { proxyConnection, sockets, logger } = httpCase(t);

        const promise = proxyConnection(logger as any, 'http://proxy.example.com:8080', 'mail.example.com', 993);
        await tick();
        respondOk(sockets[0]);
        const socket: any = await promise;

        // Late events after settlement: the temporary listeners are gone, so nothing re-settles and
        // nothing throws. Only the early error guard remains.
        assert.equal(socket.listenerCount('close'), 0, 'the temporary close listener was removed');
        assert.doesNotThrow(() => socket.emit('error', new Error('late error')), 'a late error is absorbed by the early error guard');
        assert.doesNotThrow(() => socket.emit('data', Buffer.from('HTTP/1.1 500 late\r\n\r\n')), 'late data is no longer parsed as a CONNECT response');
        assert.equal(logger._logs.error.length, 1, 'the late error was logged once by the early guard, not reported as a proxy failure');
    });

    // ============================================
    // Connection deadline
    // ============================================

    it('Proxy Connection: HTTP CONNECT timeout destroys the in-flight socket', async t => {
        const { proxyConnection, sockets, logger } = httpCase(t);

        // The proxy accepts the connection and never answers the CONNECT request
        const promise = proxyConnection(logger as any, 'http://proxy.example.com:8080', 'mail.example.com', 993, { connectionTimeout: 60 });

        let err: any = await promise.then(() => null).catch(e => e);
        assert.ok(err, 'the stalled CONNECT rejects');
        assert.equal(err.code, 'CONNECT_TIMEOUT', 'a proxy phase expiry uses the shared connection timeout code');
        assert.equal(err.details.connectionTimeout, 60, 'the configured timeout is reported');
        assert.ok(sockets[0].destroyed, 'the in-flight socket is destroyed immediately');
    });

    it('Proxy Connection: a stalled endpoint connection still hits the deadline', async t => {
        // autoConnect false: the dependency-level connection never completes
        const { proxyConnection, sockets, logger } = httpCase(t, { autoConnect: false });

        let err: any = await proxyConnection(logger as any, 'http://proxy.example.com:8080', 'mail.example.com', 993, { connectionTimeout: 60 })
            .then(() => null)
            .catch(e => e);

        assert.ok(err, 'a connection that never establishes rejects');
        assert.equal(err.code, 'CONNECT_TIMEOUT');
        assert.ok(sockets[0].destroyed, 'the shared deadline destroys the stalled socket');
    });

    it('Proxy Connection: concurrent HTTP deadlines are independent', async t => {
        const { proxyConnection, sockets, logger } = httpCase(t);

        // A short-deadline connection that stalls and a long-deadline connection that succeeds
        const stalled = proxyConnection(logger as any, 'http://proxy.example.com:8080', 'stalled.example.com', 993, { connectionTimeout: 60 })
            .then(() => null)
            .catch(e => e);
        const healthy = proxyConnection(logger as any, 'http://proxy.example.com:8080', 'healthy.example.com', 993, { connectionTimeout: 5000 });

        await tick();
        assert.equal(sockets.length, 2, 'both connections opened their own socket');

        let err: any = await stalled;
        assert.equal(err.code, 'CONNECT_TIMEOUT', 'the short deadline expired on its own connection');
        assert.ok(sockets[0].destroyed, 'only the stalled socket was destroyed');
        assert.ok(!sockets[1].destroyed, 'the other connection is untouched by the expired deadline');

        respondOk(sockets[1]);
        const socket = await healthy;
        assert.equal(socket, sockets[1], 'the longer deadline still completes normally');
    });

    it('Proxy Connection: an exhausted deadline rejects before any work starts', async t => {
        const { proxyConnection, calls, logger } = httpCase(t);

        const deadline = new ConnectionDeadline(50);
        await new Promise(resolve => setTimeout(resolve, 80));

        let err: any = await proxyConnection(logger as any, 'http://proxy.example.com:8080', 'mail.example.com', 993, { deadline })
            .then(() => null)
            .catch(e => e);

        assert.ok(err, 'no phase is started once the budget is gone');
        assert.equal(err.code, 'CONNECT_TIMEOUT');
        assert.deepEqual(calls, [], 'no socket was opened');
    });

    // ============================================
    // SOCKS
    // ============================================

    it('Proxy Connection: SOCKS5 preserves the destination hostname for remote DNS', async t => {
        const dnsCalls: any[] = [];
        const { options, result } = await socksCase(t, { proxyUrl: 'socks5://proxy.example.com:1080', host: 'mail.example.com', dnsCalls });

        assert.equal(options[0].proxy.type, 5);
        assert.equal(options[0].proxy.host, 'proxy.example.com', 'the endpoint hostname reaches the dependency unresolved');
        assert.equal(options[0].destination.host, 'mail.example.com', 'the destination hostname is left for the proxy to resolve');
        assert.equal(options[0].command, 'connect');
        assert.ok(options[0].timeout > 0, 'a strictly positive timeout is passed, never zero');
        assert.deepEqual(dnsCalls, [], 'ImapFlow resolves nothing for SOCKS5');
        assert.ok(result.value, 'the socket is returned');
    });

    it('Proxy Connection: SOCKS (alias) defaults to SOCKS5', async t => {
        const { options } = await socksCase(t, { proxyUrl: 'socks://proxy.example.com:1080', host: 'mail.example.com' });
        assert.equal(options[0].proxy.type, 5);
        assert.equal(options[0].destination.host, 'mail.example.com');
    });

    it('Proxy Connection: SOCKS5 passes IP literals through unchanged', async t => {
        let { options } = await socksCase(t, { proxyUrl: 'socks5://proxy.example.com:1080', host: '192.168.1.1' });
        assert.equal(options[0].destination.host, '192.168.1.1', 'IPv4 literal unchanged');

        ({ options } = await socksCase(t, { proxyUrl: 'socks5://proxy.example.com:1080', host: '2001:db8::9' }));
        assert.equal(options[0].destination.host, '2001:db8::9', 'IPv6 literal unchanged');
    });

    it('Proxy Connection: SOCKS4a preserves the destination hostname for remote DNS', async t => {
        const dnsCalls: any[] = [];
        const { options } = await socksCase(t, { proxyUrl: 'socks4a://proxy.example.com:1080', host: 'mail.example.com', dnsCalls });

        assert.equal(options[0].proxy.type, 4, 'the dependency uses proxy type 4 for both SOCKS4 and SOCKS4a');
        assert.equal(options[0].destination.host, 'mail.example.com', 'the hostname is preserved so the proxy resolves it');
        assert.deepEqual(dnsCalls, [], 'no local lookup for SOCKS4a');
    });

    it('Proxy Connection: SOCKS4 resolves the destination locally to IPv4', async t => {
        const dnsCalls: any[] = [];
        const { options } = await socksCase(t, {
            proxyUrl: 'socks4://proxy.example.com:1080',
            host: 'mail.example.com',
            resolve4Result: ['93.184.216.34'],
            dnsCalls
        });

        assert.equal(options[0].proxy.type, 4);
        assert.equal(options[0].destination.host, '93.184.216.34', 'SOCKS4 gets a resolved IPv4 address, not a hostname');
        assert.deepEqual(dnsCalls, [['resolve4', 'mail.example.com']], 'the lookup is explicitly IPv4 only');
    });

    it('Proxy Connection: SOCKS4 reports an unresolvable destination', async t => {
        const { result } = await socksCase(t, {
            proxyUrl: 'socks4://proxy.example.com:1080',
            host: 'mail.example.com',
            resolve4Result: []
        });

        assert.ok(result.err, 'an empty IPv4 lookup fails the connection');
        assert.equal(result.err.code, 'EPROXY');
    });

    it('Proxy Connection: SOCKS4 and SOCKS4a reject IPv6 destinations clearly', async t => {
        for (let proxyUrl of ['socks4://proxy.example.com:1080', 'socks4a://proxy.example.com:1080']) {
            const { options, result, logger } = await socksCase(t, { proxyUrl, host: '2001:db8::9' });

            assert.ok(result.err, `${proxyUrl} rejects an IPv6 destination`);
            assert.equal(result.err.code, 'UnsupportedProxyAddress', 'the failure names the unsupported address type');
            assert.deepEqual(options, [], 'no request is emitted with the address in the wrong field');
            assert.equal(logger._logs.error.length, 1, 'the failure is logged');
        }
    });

    it('Proxy Connection: bracketed IPv6 proxy URL yields a bare literal endpoint', async t => {
        const { options, logger } = await socksCase(t, { proxyUrl: 'socks5://[2001:db8::1]:1080', host: 'mail.example.com' });

        assert.equal(options[0].proxy.host, '2001:db8::1', 'brackets are stripped before the address reaches the dependency');
        assert.ok(logger._logs.info[0].proxyUrl.includes('[2001:db8::1]'), 'logs keep a valid bracketed URL');
    });

    it('Proxy Connection: SOCKS passes credentials and hides them in logs', async t => {
        const { options, logger } = await socksCase(t, { proxyUrl: 'socks5://testuser:testpass@proxy.example.com:1080', host: 'mail.example.com' });

        assert.equal(options[0].proxy.userId, 'testuser');
        assert.equal(options[0].proxy.password, 'testpass');
        assert.ok(!logger._logs.info[0].proxyUrl.includes('testpass'));
        assert.ok(logger._logs.info[0].proxyUrl.includes('(hidden)'));
    });

    it('Proxy Connection: SOCKS with username only', async t => {
        const { options } = await socksCase(t, { proxyUrl: 'socks5://testuser@proxy.example.com:1080', host: 'mail.example.com' });
        assert.equal(options[0].proxy.userId, 'testuser');
        assert.equal(options[0].proxy.password, '', 'empty string from URL parsing');
    });

    it('Proxy Connection: SOCKS default port', async t => {
        const { options } = await socksCase(t, { proxyUrl: 'socks5://proxy.example.com', host: 'mail.example.com' });
        assert.equal(options[0].proxy.port, 1080);
    });

    it('Proxy Connection: SOCKS failure is reported and redacted', async t => {
        const logger = createMockLogger();
        const testError = new Error('SOCKS connection failed');

        const { proxyConnection } = stubTransports(t, {
            socksCreateConnection: async () => {
                throw testError;
            }
        });

        let err: any = await proxyConnection(logger as any, 'socks5://user:secret@proxy.example.com:1080', 'mail.example.com', 993)
            .then(() => null)
            .catch(e => e);

        assert.equal(err, testError, 'the dependency error is preserved');
        assert.equal(logger._logs.error.length, 1);
        assert.ok(!logger._logs.error[0].proxyUrl.includes('secret'));
        assert.ok(logger._logs.error[0].proxyUrl.includes('(hidden)'));
    });

    it('Proxy Connection: SOCKS returning no socket fails', async t => {
        const logger = createMockLogger();

        const { proxyConnection } = stubTransports(t, { socksCreateConnection: async () => ({}) });

        let err: any = await proxyConnection(logger as any, 'socks5://proxy.example.com:1080', 'mail.example.com', 993)
            .then(() => null)
            .catch(e => e);

        assert.ok(err, 'a missing socket is an error rather than an undefined return');
        assert.equal(err.code, 'EPROXY');
    });

    it('Proxy Connection: the SOCKS dependency timeout is normalized to CONNECT_TIMEOUT', async t => {
        const logger = createMockLogger();

        const { proxyConnection } = stubTransports(t, {
            socksCreateConnection: async () => {
                // the shape the socks client uses for its own expiry
                throw new Error('Proxy connection timed out');
            }
        });

        let err: any = await proxyConnection(logger as any, 'socks5://proxy.example.com:1080', 'mail.example.com', 993, { connectionTimeout: 5000 })
            .then(() => null)
            .catch(e => e);

        assert.equal(err.code, 'CONNECT_TIMEOUT', 'SOCKS and HTTP expose the same timeout code');
        assert.equal(err.details.connectionTimeout, 5000, 'the normalized error carries the configured timeout');
        assert.ok(err._err, 'the dependency error is kept for diagnostics');
    });

    it('Proxy Connection: a stalled SOCKS negotiation hits the shared deadline', async t => {
        const logger = createMockLogger();

        const { proxyConnection } = stubTransports(t, {
            socksCreateConnection: () => new Promise(() => {}) // never settles
        });

        let err: any = await proxyConnection(logger as any, 'socks5://proxy.example.com:1080', 'mail.example.com', 993, { connectionTimeout: 60 })
            .then(() => null)
            .catch(e => e);

        assert.equal(err.code, 'CONNECT_TIMEOUT', 'the shared deadline bounds the dependency');
    });

    it('Proxy Connection: SOCKS4 local lookup runs inside the deadline', async t => {
        const logger = createMockLogger();

        const { proxyConnection } = stubTransports(t, {
            socksCreateConnection: async () => ({ socket: createFakeSocket() }),
            dnsStub: { resolve4: () => new Promise(() => {}), resolve: () => new Promise(() => {}) }
        });

        let err: any = await proxyConnection(logger as any, 'socks4://proxy.example.com:1080', 'mail.example.com', 993, { connectionTimeout: 60 })
            .then(() => null)
            .catch(e => e);

        assert.equal(err.code, 'CONNECT_TIMEOUT', 'a stalled DNS lookup cannot outlive the connection timeout');
    });

    // ============================================
    // Edge cases
    // ============================================

    it('Proxy Connection: Unknown protocol returns undefined', async t => {
        const logger = createMockLogger();
        const { proxyConnection } = stubTransports(t, {});

        const result = await proxyConnection(logger as any, 'ftp://proxy.example.com:21', 'mail.example.com', 993);

        assert.equal(result, undefined);
    });

    it('Proxy Connection: detachEarlyErrorHandler removes the early guard', async t => {
        const { proxyConnection, detachEarlyErrorHandler, sockets, logger } = httpCase(t);

        const promise = proxyConnection(logger as any, 'http://proxy.example.com:8080', 'mail.example.com', 993);
        await tick();
        respondOk(sockets[0]);
        const socket: any = await promise;

        assert.ok(socket.listenerCount('error') >= 1, 'early error handler attached on return');
        assert.ok(typeof socket._earlyErrorHandler === 'function', 'handler reference stored on the socket');

        detachEarlyErrorHandler(socket);

        assert.equal(socket.listenerCount('error'), 0, 'early error handler removed after detach');
        assert.equal(socket._earlyErrorHandler, null, 'stored handler reference cleared');

        // Detaching again (or on a bare socket) must be a safe no-op.
        assert.doesNotThrow(() => detachEarlyErrorHandler(socket));
        assert.doesNotThrow(() => detachEarlyErrorHandler(createFakeSocket()));
    });

    it('Proxy Connection: socket without .on skips early error handler attach', async t => {
        const logger = createMockLogger();
        const { proxyConnection } = stubTransports(t, { socksCreateConnection: async () => ({ socket: { write() {} } }) });

        const socket: any = await proxyConnection(logger as any, 'socks5://proxy.example.com:1080', 'mail.example.com', 993);

        assert.ok(socket, 'a socket-like object without an event emitter interface is still returned');
        assert.equal(socket._earlyErrorHandler, undefined, 'no handler is attached to it');
    });

    // ============================================
    // Credential handling and malformed userinfo
    // ============================================

    it('Proxy Connection: a proxy password with a bare percent sign still connects', async t => {
        // URL userinfo is percent-encoded, so a bare '%' is not valid encoding. Decoding it must not
        // throw out of the connect callback, which would both crash the process and leave the
        // connection promise pending forever.
        const { proxyConnection, sockets, logger } = httpCase(t);

        const promise = proxyConnection(logger as any, 'http://user:p%ss@proxy.example.com:8080', 'mail.example.com', 993);
        await tick();

        const authHeader = sockets[0].writes[0].match(/Proxy-Authorization: Basic (\S+)/);
        assert.ok(authHeader, 'credentials are still sent');
        assert.equal(Buffer.from(authHeader[1], 'base64').toString(), 'user:p%ss', 'the undecodable value is used as it came in');

        respondOk(sockets[0]);
        const socket = await promise;
        assert.ok(socket, 'the tunnel is established');
    });

    it('Proxy Connection: a SOCKS failure never carries the proxy password', async t => {
        // The socks client attaches its full options object - password included - to the errors it
        // throws, and a logger that serializes error properties would write it out in clear text.
        const logger = createMockLogger();

        const { proxyConnection } = stubTransports(t, {
            socksCreateConnection: async (opts: any) => {
                let err: any = new Error('Socks5 proxy rejected connection - Failure');
                err.options = opts; // this is what socks does
                throw err;
            }
        });

        let err: any = await proxyConnection(logger as any, 'socks5://user:secretpass@proxy.example.com:1080', 'mail.example.com', 993)
            .then(() => null)
            .catch(e => e);

        assert.ok(err, 'the failure still propagates');
        assert.equal(err.options, undefined, 'the credential-bearing options object is stripped from the error');
        assert.ok(!JSON.stringify(logger._logs.error).includes('secretpass'), 'the password does not reach the log');
    });

    it('Proxy Connection: a normalized SOCKS timeout carries no credentials either', async t => {
        const logger = createMockLogger();

        const { proxyConnection } = stubTransports(t, {
            socksCreateConnection: async (opts: any) => {
                let err: any = new Error('Proxy connection timed out');
                err.options = opts;
                throw err;
            }
        });

        let err: any = await proxyConnection(logger as any, 'socks5://user:secretpass@proxy.example.com:1080', 'mail.example.com', 993, {
            connectionTimeout: 5000
        })
            .then(() => null)
            .catch(e => e);

        assert.equal(err.code, 'CONNECT_TIMEOUT');
        assert.equal(err._err.options, undefined, 'the retained diagnostic error is stripped too');
        assert.ok(!JSON.stringify(logger._logs.error).includes('secretpass'), 'the password does not reach the log');
    });
});
