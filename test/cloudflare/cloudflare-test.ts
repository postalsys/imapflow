import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startMockImapServer, type MockImapServer } from './mock-imap-server.js';
import type { Scenario, ScenarioResult } from './worker.js';

// Runs the built ES module output on the Cloudflare Workers runtime. `wrangler dev` starts a
// local workerd with test/cloudflare/worker.ts, which drives an ImapFlow session against the
// server named in each scenario and reports what it saw. The mock server below covers the
// protocol paths, the network cases cover what only a real server with a certificate the
// runtime trusts can show: workerd validates certificates and refuses to turn that off.
//
// Started by `npm run test:workers`, which builds dist/ first. Not part of `npm test`.

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

const WRANGLER_STARTUP_TIMEOUT = 120 * 1000;
const REQUEST_TIMEOUT = 60 * 1000;

const freePort = (): Promise<number> =>
    new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const port = (probe.address() as net.AddressInfo).port;
            probe.close(() => resolve(port));
        });
    });

interface EtherealAccount {
    user: string;
    pass: string;
    imap: { host: string; port: number; secure: boolean };
}

// A throwaway account on Ethereal (https://ethereal.email), the test mail service run by the
// Nodemailer project: everything sent to it lands in its own inbox and nothing leaves
const createEtherealAccount = async (): Promise<EtherealAccount | null> => {
    try {
        const response = await fetch('https://api.nodemailer.com/user', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ requestor: 'imapflow', version: require(path.join(root, 'package.json')).version }),
            signal: AbortSignal.timeout(20 * 1000)
        });
        const account = (await response.json()) as EtherealAccount & { status?: string };
        return account && account.status === 'success' && account.imap ? account : null;
    } catch {
        return null;
    }
};

describe('Cloudflare Workers', { timeout: 10 * 60 * 1000 }, () => {
    let wrangler: ChildProcess | null = null;
    let workerUrl = '';
    let output = '';
    let server: MockImapServer;

    const run = async (scenario: Scenario): Promise<ScenarioResult> => {
        const response = await fetch(workerUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(scenario),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT)
        });
        assert.equal(response.status, 200, 'the worker answered');
        return (await response.json()) as ScenarioResult;
    };

    const appendSource = (subject: string) =>
        `Subject: ${subject}\r\nFrom: sender@example.com\r\nTo: recipient@example.com\r\nMessage-ID: <${Date.now()}@example.com>\r\nDate: Mon, 7 Sep 2026 10:00:00 +0000\r\n\r\nHello from a Worker\r\n`;

    before(async () => {
        server = await startMockImapServer({ starttls: true, compress: true });

        const port = await freePort();
        wrangler = spawn(
            process.execPath,
            [
                path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
                'dev',
                '--config',
                path.join(here, 'wrangler.jsonc'),
                '--ip',
                '127.0.0.1',
                '--port',
                String(port),
                '--show-interactive-dev-session=false',
                '--log-level',
                'info'
            ],
            {
                cwd: root,
                env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true', NO_COLOR: '1' },
                stdio: ['ignore', 'pipe', 'pipe'],
                // its own process group, so the workerd children go away with it
                detached: process.platform !== 'win32'
            }
        );
        const collect = (chunk: Buffer) => {
            output += chunk.toString();
        };
        wrangler.stdout!.on('data', collect);
        wrangler.stderr!.on('data', collect);

        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('wrangler dev did not become ready:\n' + output)), WRANGLER_STARTUP_TIMEOUT);
            const check = () => {
                const match = output.match(/Ready on (http:\/\/[^\s]+)/);
                if (match) {
                    clearTimeout(timer);
                    workerUrl = match[1]!;
                    resolve();
                }
            };
            wrangler!.stdout!.on('data', check);
            wrangler!.stderr!.on('data', check);
            wrangler!.once('exit', code => {
                clearTimeout(timer);
                reject(new Error(`wrangler dev exited with ${code}:\n` + output));
            });
        });
    });

    after(async () => {
        if (wrangler && wrangler.exitCode === null) {
            const exited = new Promise<void>(resolve => wrangler!.once('exit', () => resolve()));
            try {
                if (process.platform !== 'win32') {
                    process.kill(-wrangler.pid!, 'SIGTERM');
                } else {
                    wrangler.kill();
                }
            } catch {
                wrangler.kill();
            }
            await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 10 * 1000))]);
        }
        await server.close();
    });

    it('runs a cleartext session: login, LIST, SELECT, APPEND, FETCH, SEARCH, LOGOUT', async () => {
        const result = await run({
            host: server.host,
            port: server.port,
            secure: false,
            doSTARTTLS: false,
            disableCompression: true,
            auth: { user: 'user', pass: 'pass' },
            append: appendSource('cleartext')
        });
        assert.equal(result.ok, true, JSON.stringify(result.error) + '\n' + result.logs.join('\n'));
        assert.deepEqual(result.steps, ['connect', 'list', 'lock', 'append', 'fetch', 'search', 'logout']);
        assert.equal(result.secureConnection, false);
        assert.equal(result.compressed, false);
        assert.deepEqual(result.list, ['INBOX', 'Sent']);
        assert.equal(result.mailbox?.path, 'INBOX');
        assert.ok(result.appended && result.appended.uid, 'APPENDUID was reported');
        assert.equal(result.messages?.length, result.mailbox?.exists);
        const appended = result.messages?.find(message => message.uid === (result.appended as { uid: number }).uid);
        assert.ok(appended, 'the appended message was fetched back');
        assert.equal(appended.subject, 'cleartext');
        assert.deepEqual(appended.flags, ['\\Seen']);
        assert.equal(appended.source, appendSource('cleartext').slice(0, 40));
        assert.ok(Array.isArray(result.search) && result.search.includes(appended.uid));
        assert.ok(result.stats && result.stats.sent > 0 && result.stats.received > 0);
        assert.ok(
            server.commands.some(command => command.startsWith('APPEND INBOX')),
            'the mock saw the APPEND'
        );
    });

    it('negotiates COMPRESS=DEFLATE through node:zlib', async () => {
        const result = await run({
            host: server.host,
            port: server.port,
            secure: false,
            doSTARTTLS: false,
            auth: { user: 'user', pass: 'pass' },
            append: appendSource('compressed')
        });
        assert.equal(result.ok, true, JSON.stringify(result.error) + '\n' + result.logs.join('\n'));
        assert.equal(result.compressed, true, 'the session switched to DEFLATE framing');
        assert.ok(server.commands.includes('COMPRESS DEFLATE'));
        const appended = result.messages?.find(message => message.subject === 'compressed');
        assert.ok(appended, 'the message appended over the compressed session was fetched back');
        assert.ok(Array.isArray(result.search) && result.search.includes(appended.uid));
    });

    it('logs through the default pino logger', async () => {
        const result = await run({
            host: server.host,
            port: server.port,
            secure: false,
            doSTARTTLS: false,
            disableCompression: true,
            defaultLogger: true,
            auth: { user: 'user', pass: 'pass' }
        });
        assert.equal(result.ok, true, JSON.stringify(result.error) + '\n' + result.logs.join('\n'));
        assert.ok(
            result.logs.some(line => line.startsWith('debug: c ')),
            'commands were logged'
        );
    });

    it('reports a STARTTLS upgrade as a TLS failure and closes the connection', async () => {
        // workerd can only upgrade a socket that has no read in flight, which ImapFlow's
        // asynchronous STARTTLS exchange can not guarantee, so the upgrade is refused by the
        // runtime. What matters is that the refusal is reported as a TLS failure and the
        // session does not linger half upgraded. Implicit TLS is the way in on Workers.
        const before = server.commands.length;
        const result = await run({
            host: server.host,
            port: server.port,
            secure: false,
            doSTARTTLS: true,
            auth: { user: 'user', pass: 'pass' }
        });
        assert.equal(result.ok, false);
        assert.ok(server.commands.slice(before).includes('STARTTLS'), 'the upgrade was requested');
        assert.equal(result.error?.tlsFailed, true, 'reported as a TLS failure: ' + JSON.stringify(result.error));
        assert.equal(result.secureConnection, false);
        assert.ok(result.logs.includes('debug: Connection closed'), 'the connection was closed');
    });

    it('idles and picks up an EXISTS pushed by the server', async () => {
        const before = server.messages.length;
        const result = await run({
            host: server.host,
            port: server.port,
            secure: false,
            doSTARTTLS: false,
            disableCompression: true,
            auth: { user: 'user', pass: 'pass' },
            idle: true
        });
        assert.equal(result.ok, true, JSON.stringify(result.error) + '\n' + result.logs.join('\n'));
        assert.ok(result.steps.includes('idle'));
        assert.equal(result.idle?.prevCount, before);
        assert.equal(result.idle?.count, before + 1, 'the EXISTS pushed during IDLE was reported');
        assert.equal(result.idle?.existsAfter, before + 1);
        assert.ok(server.commands.includes('IDLE') && server.commands.includes('DONE'), 'IDLE was entered and broken with DONE');
    });

    it('refuses tls.rejectUnauthorized: false with ERR_OPTION_NOT_IMPLEMENTED', async () => {
        const result = await run({
            host: server.host,
            port: server.port,
            secure: true,
            auth: { user: 'user', pass: 'pass' },
            tls: { rejectUnauthorized: false }
        });
        assert.equal(result.ok, false);
        assert.equal(result.error?.code, 'ERR_OPTION_NOT_IMPLEMENTED', JSON.stringify(result.error));
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
            auth: { user: account.user, pass: account.pass },
            append: appendSource('workers over tls')
        });
        assert.equal(result.ok, true, JSON.stringify(result.error) + '\n' + result.logs.join('\n'));
        assert.equal(result.secureConnection, true);
        assert.deepEqual(result.steps, ['connect', 'list', 'lock', 'append', 'fetch', 'search', 'logout']);
        assert.ok(result.list && result.list.includes('INBOX'));
        const appended = result.messages?.find(message => message.subject === 'workers over tls');
        assert.ok(appended, 'the appended message was fetched back over TLS');
        assert.ok(Array.isArray(result.search) && result.search.includes(appended.uid));
    });
});
