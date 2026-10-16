import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startMockImapServer, type MockImapServer } from '../cloudflare/mock-imap-server.js';
import { startTourServer, assertTour, details } from '../fixtures/api-tour-server.js';
import { freePort, createEtherealAccount, reachable } from '../cloudflare/harness.js';
import type { Scenario, ScenarioResult } from '../cloudflare/worker.js';

// Runs the built ES module output on celld (https://celld.dev), a self-hosted runtime for
// Cloudflare-style Workers. `celld dev` runs in Docker on the host network, so the Worker in
// test/celld/worker.ts reaches the mock servers this process starts on the loopback interface.
// celld has no node:net, node:tls or node:dns, so the sessions connect through
// createSocketsTransport() over cloudflare:sockets.
//
// Started by `npm run test:celld`, which builds dist/ first. Needs Docker with host networking
// (Linux, OrbStack, Docker Desktop with host networking enabled). Not part of `npm test`.
// CELLD_IMAGE overrides the image.

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

const IMAGE = process.env.CELLD_IMAGE || 'ghcr.io/denoland/celld:0.6.2';
const STARTUP_TIMEOUT = 180 * 1000;
const REQUEST_TIMEOUT = 60 * 1000;

const docker = (args: string[], timeout = 30 * 1000) => spawnSync('docker', args, { encoding: 'utf8', timeout });

const dockerAvailable = (): boolean => docker(['version', '--format', '{{.Server.Arch}}'], 15 * 1000).status === 0;

// `celld dev` bundles the Worker with esbuild from PATH, which the image does not ship. The
// linux build of the esbuild version the project uses is fetched once into .celld/
const linuxEsbuild = (): string => {
    const arch = docker(['version', '--format', '{{.Server.Arch}}']).stdout.trim() === 'arm64' ? 'arm64' : 'x64';
    const version = require(path.join(root, 'node_modules', 'esbuild', 'package.json')).version;
    const dir = path.join(root, '.celld', `esbuild-${version}-linux-${arch}`);
    const binary = path.join(dir, 'package', 'bin', 'esbuild');
    if (!fs.existsSync(binary)) {
        fs.mkdirSync(dir, { recursive: true });
        const tarball = execFileSync('npm', ['pack', `@esbuild/linux-${arch}@${version}`, '--pack-destination', dir, '--silent'], { encoding: 'utf8' }).trim();
        execFileSync('tar', ['xzf', path.join(dir, tarball), '-C', dir]);
    }
    return binary;
};

// Under the 15 minute CI job limit, so a hang still reaches after(), which keeps the logs and
// removes the container. CI has Docker, so the suite is only skipped without it locally
describe('celld', { timeout: 12 * 60 * 1000, skip: !process.env.CI && !dockerAvailable() && 'Docker is not available' }, () => {
    const container = `imapflow-celld-test-${process.pid}`;
    let workerUrl = '';
    let server: MockImapServer;
    // advertises STARTTLS without supporting it, the upgrade is refused with BAD
    let refusingServer: MockImapServer;
    let tlsServer: MockImapServer;
    // accepts connections, greets, then never answers a command
    let silentServer: net.Server;
    const silentSockets = new Set<net.Socket>();
    let silentPort = 0;

    const post = async (route: string, body: unknown): Promise<any> => {
        const response = await fetch(workerUrl + route, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT)
        });
        const text = await response.text();
        assert.equal(response.status, 200, 'the worker answered: ' + text.slice(0, 500));
        return JSON.parse(text);
    };
    const run = (scenario: Scenario): Promise<ScenarioResult> => post('/', scenario);

    const mock = (target: MockImapServer, extra?: Partial<Scenario>): Scenario => ({
        host: target.host,
        port: target.port,
        secure: false,
        doSTARTTLS: false,
        transport: 'sockets',
        auth: { user: 'user', pass: 'pass' },
        ...extra
    });

    const appendSource = (subject: string) =>
        `Subject: ${subject}\r\nFrom: sender@example.com\r\nTo: recipient@example.com\r\nMessage-ID: <${Date.now()}@example.com>\r\nDate: Mon, 7 Sep 2026 10:00:00 +0000\r\n\r\nHello from celld\r\n`;

    before(async () => {
        server = await startMockImapServer({ starttls: true, compress: true });
        refusingServer = await startMockImapServer({ capabilities: ['STARTTLS'] });
        tlsServer = await startMockImapServer({ secure: true });
        silentServer = net.createServer(socket => {
            silentSockets.add(socket);
            socket.on('error', () => false);
            socket.write('* OK [CAPABILITY IMAP4rev1] silent\r\n');
        });
        await new Promise<void>(resolve => silentServer.listen(0, '127.0.0.1', resolve));
        silentPort = (silentServer.address() as net.AddressInfo).port;

        const esbuild = linuxEsbuild();
        // the tmpfs below needs its mount point, the project is mounted read-only
        fs.mkdirSync(path.join(here, '.celld'), { recursive: true });
        const port = await freePort();
        docker(['rm', '-f', container]);
        const started = docker(
            [
                'run',
                '-d',
                '--name',
                container,
                '--network',
                'host',
                '-v',
                `${root}:/repo:ro`,
                '-v',
                `${esbuild}:/usr/local/bin/esbuild:ro`,
                // celld dev keeps its local object store and state next to the project
                '--tmpfs',
                '/repo/test/celld/.celld',
                '-w',
                '/repo/test/celld',
                IMAGE,
                'dev',
                '.',
                '--port',
                String(port),
                '--logs'
            ],
            STARTUP_TIMEOUT
        );
        assert.equal(started.status, 0, 'celld container started: ' + started.stderr);
        workerUrl = `http://127.0.0.1:${port}`;

        const deadline = Date.now() + STARTUP_TIMEOUT;
        for (;;) {
            try {
                const response = await fetch(workerUrl, { signal: AbortSignal.timeout(2000) });
                if (response.status === 405) {
                    break;
                }
            } catch {
                // not listening yet
            }
            if (Date.now() > deadline) {
                const logs = docker(['logs', container]);
                throw new Error('celld dev did not become ready:\n' + logs.stdout + logs.stderr);
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    });

    after(async () => {
        if (process.env.CELLD_KEEP_LOGS) {
            const logs = docker(['logs', container]);
            fs.writeFileSync(path.join(root, '.celld', 'celld.log'), logs.stdout + logs.stderr);
        }
        docker(['rm', '-f', container]);
        await Promise.all([server.close(), refusingServer.close(), tlsServer.close()]);
        silentSockets.forEach(socket => socket.destroy());
        await new Promise(resolve => silentServer.close(resolve));
    });

    it('has no node:net, node:tls or node:dns, and no streaming zlib', async () => {
        const response = await fetch(workerUrl + '/runtime', { signal: AbortSignal.timeout(REQUEST_TIMEOUT) });
        const runtime = (await response.json()) as Record<string, string>;
        assert.equal(runtime['net.connect'], 'throws: node:net.connect is not implemented in celld');
        assert.equal(runtime['net.isIP'], 'throws: node:net.isIP is not implemented in celld');
        assert.equal(runtime['tls.connect'], 'throws: node:tls.connect is not implemented in celld');
        assert.equal(runtime['dns.lookup'], 'throws: node:dns.lookup is not implemented in celld');
        assert.equal(runtime['zlib.createDeflateRaw'], 'undefined');
        assert.equal(runtime['zlib.deflateRawSync'], 'ok: object');
    });

    it('fails to connect without the sockets transport', async () => {
        const result = await run(mock(server, { transport: undefined }));
        assert.equal(result.ok, false);
        assert.match(result.error?.message || '', /node:net\.connect is not implemented in celld/);
    });

    it('runs a cleartext session, skipping COMPRESS, with a 2 MB APPEND and download()', async () => {
        const before = server.commands.length;
        const size = 2 * 1024 * 1024;
        const result = await run(mock(server, { append: appendSource('cleartext'), appendSize: size, download: true }));
        assert.equal(result.ok, true, details(result));
        assert.deepEqual(result.steps, ['connect', 'list', 'lock', 'append', 'fetch', 'search', 'download', 'logout']);
        assert.equal(result.secureConnection, false);
        assert.ok(result.capabilities?.includes('COMPRESS=DEFLATE'), 'the server offered COMPRESS');
        assert.equal(result.compressed, false);
        assert.ok(!server.commands.slice(before).some(command => command.startsWith('COMPRESS')), 'COMPRESS was never sent');
        assert.deepEqual(result.list, ['INBOX', 'Sent']);
        const appended = result.messages?.find(message => message.uid === (result.appended as { uid: number }).uid);
        assert.ok(appended, 'the appended message was fetched back');
        assert.equal(appended.subject, 'cleartext');
        assert.equal(appended.source, appendSource('cleartext').slice(0, 40));
        assert.ok(appended.size! >= size);
        assert.equal(result.downloaded, appended.size, 'download() streamed the whole message');
        assert.ok(Array.isArray(result.search) && result.search.includes(appended.uid));
    });

    it('runs the API tour against ImapKit', async () => {
        // mailbox management, STATUS, FETCH of structure and parts, download() and downloadMany(),
        // flags, SEARCH, COPY, MOVE, EXPUNGE and QUOTA against a server with every extension
        const tourServer = await startTourServer({ transport: 'sockets' });
        try {
            const result = await run(tourServer.scenario);
            assertTour(result);
            assert.ok(result.capabilities?.includes('COMPRESS=DEFLATE'), 'the server offered COMPRESS');
            assert.equal(result.compressed, false, 'COMPRESS was skipped');
            assert.deepEqual(tourServer.bad, [], 'ImapKit answered client input with BAD');
        } finally {
            await tourServer.close();
        }
    });

    it('logs through the default pino logger', async () => {
        const result = await run(mock(server, { defaultLogger: true }));
        assert.equal(result.ok, true, details(result));
        assert.ok(
            result.logs.some(line => line.startsWith('debug: c ')),
            'commands were logged'
        );
    });

    it('idles and picks up an EXISTS pushed by the server', async () => {
        const before = server.messages.length;
        const result = await run(mock(server, { idle: true }));
        assert.equal(result.ok, true, details(result));
        assert.equal(result.idle?.count, before + 1, 'the EXISTS pushed during IDLE was reported');
        assert.ok(server.commands.includes('IDLE') && server.commands.includes('DONE'));
    });

    it('starts STARTTLS and verifies the certificate: a self-signed one is rejected', async () => {
        const before = server.commands.length;
        const result = await run(mock(server, { doSTARTTLS: true }));
        assert.equal(result.ok, false);
        assert.ok(server.commands.slice(before).includes('STARTTLS'), 'the upgrade was requested');
        assert.equal(result.error?.tlsFailed, true, details(result));
        assert.match(result.error?.message || '', /invalid peer certificate/);
        assert.equal(result.secureConnection, false);
    });

    it('keeps reading after a refused STARTTLS and continues in cleartext', async () => {
        const result = await run(mock(refusingServer, { doSTARTTLS: undefined }));
        assert.equal(result.ok, true, details(result));
        assert.ok(refusingServer.commands.includes('STARTTLS'), 'the upgrade was requested');
        assert.equal(result.secureConnection, false);
    });

    it('rejects a self-signed certificate over implicit TLS', async () => {
        const result = await run(mock(tlsServer, { secure: true }));
        assert.equal(result.ok, false);
        assert.match(result.error?.message || '', /invalid peer certificate/, details(result));
    });

    it('refuses the TLS options the runtime can not honor, and a proxy', async () => {
        const refused: Array<[Partial<Scenario>, RegExp]> = [
            [{ secure: true, tls: { rejectUnauthorized: false } }, /tls\.rejectUnauthorized=false/],
            [{ secure: true, tls: { ca: 'not a certificate' } }, /tls\.ca/],
            [{ secure: true, servername: 'imap.example.com' }, /servername/],
            [{ proxy: 'socks5://127.0.0.1:1080' }, /proxy option can not be combined/]
        ];
        for (const [extra, message] of refused) {
            const result = await run(mock(tlsServer, extra));
            assert.equal(result.ok, false);
            assert.equal(result.error?.code, 'UnsupportedTransportOption', details(result));
            assert.match(result.error?.message || '', message);
        }
    });

    it('times out a socket the server stopped answering', async () => {
        const result = await run({
            host: '127.0.0.1',
            port: silentPort,
            transport: 'sockets',
            doSTARTTLS: false,
            socketTimeout: 2000,
            auth: { user: 'user', pass: 'pass' }
        });
        assert.equal(result.ok, false);
        assert.ok(result.error?.code === 'ETIMEOUT' || result.logs.some(line => line.includes('Socket timeout')), details(result));
    });

    it('closes the socket when the request that opened it ends', async t => {
        // needs two requests in the same isolate, which celld dev keeps for back-to-back requests
        // but does not promise: a replaced isolate is retried, not a failure
        for (let attempt = 1; attempt <= 3; attempt++) {
            const held = await post('/hold', mock(server));
            assert.equal(held.ok, true, details(held));
            const reused = await post('/reuse', {});
            if (reused.error?.message === 'no held session, the isolate was replaced') {
                continue;
            }
            assert.equal(reused.ok, false, 'the session did not survive its request');
            return;
        }
        t.skip('celld replaced the isolate between the requests three times');
    });

    it('keeps a session running in waitUntil() after the response', async () => {
        const before = server.messages.length;
        const started = await post('/background', mock(server, { append: appendSource('background'), idle: true }));
        assert.equal(started.started, true);
        let result: ScenarioResult | null = null;
        for (let i = 0; i < 60 && !result; i++) {
            await new Promise(resolve => setTimeout(resolve, 500));
            const response = await fetch(workerUrl + '/background', { signal: AbortSignal.timeout(REQUEST_TIMEOUT) });
            result = (await response.json()) as ScenarioResult | null;
        }
        assert.ok(result, 'the background session finished');
        assert.equal(result.ok, true, details(result));
        assert.ok(result.steps.includes('idle'));
        assert.ok(server.messages.length >= before + 1, 'the message appended in the background reached the server');
    });

    it('runs a session over implicit TLS against Ethereal', async t => {
        const account = await createEtherealAccount();
        if (!account) {
            t.skip('could not create an Ethereal test account (no network?)');
            return;
        }
        const result = await run({
            host: account.imap.host,
            port: account.imap.port,
            secure: true,
            transport: 'sockets',
            auth: { user: account.user, pass: account.pass },
            append: appendSource('celld over tls')
        });
        assert.equal(result.ok, true, details(result));
        assert.equal(result.secureConnection, true);
        assert.equal(result.tls, false, 'the runtime reports no cipher details');
        assert.deepEqual(result.steps, ['connect', 'list', 'lock', 'append', 'fetch', 'search', 'logout']);
        const appended = result.messages?.find(message => message.subject === 'celld over tls');
        assert.ok(appended, 'the appended message was fetched back over TLS');
    });

    it('upgrades a public server with STARTTLS and reads its capabilities over TLS', async t => {
        // outlook.office365.com offers STARTTLS on 143 with a publicly trusted certificate. No
        // credentials: connect() stops after the upgrade, with the capabilities read over TLS
        const host = 'outlook.office365.com';
        if (!(await reachable(host, 143))) {
            t.skip(`${host}:143 is not reachable`);
            return;
        }
        const result = await run({ host, port: 143, secure: false, doSTARTTLS: true, transport: 'sockets' });
        assert.equal(result.secureConnection, true, details(result));
        // no credentials, so connect() stops after the upgrade with a non-TLS error
        assert.ok(!result.error?.tlsFailed, details(result));
        assert.ok(result.capabilities?.includes('IMAP4rev1'));
        assert.ok(!result.capabilities?.includes('STARTTLS'), 'the capabilities were read again after the upgrade');
    });
});
