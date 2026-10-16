import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodeCrypto from 'node:crypto';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright-core';
import { assertTour, details } from '../fixtures/api-tour-server.js';
import { ALL_PLUGINS } from '../fixtures/imapkit-config.js';
import type { PageResult, PageScenario } from './types.js';
// @ts-expect-error a plain JavaScript shim without declarations
import { createHash as createHashShim } from './shims/crypto.js';

const md5Shim = (input: string): string => createHashShim('md5').update(input).digest('hex');

// Runs the built ES module output in headless Chrome. test/browser/page.ts is bundled with esbuild
// the way an application bundles ImapFlow for a browser: the Node.js builtins it imports are
// replaced (node:stream with readable-stream, node:events with events, Buffer from buffer,
// node:crypto with an MD5 shim, node:zlib, node:net, node:tls and node:dns with stubs). There
// are no sockets in a browser, so the sessions run through the transport option over in-memory
// connections to the browser build of ImapKit in the same page.
//
// Started by `npm run test:browser`, which builds dist/ first. Needs Chrome: CHROME_PATH, or the
// installed Google Chrome that playwright-core finds. Skipped without one, except in CI. Not part
// of `npm test`.

const here = path.dirname(fileURLToPath(import.meta.url));
const shim = (name: string) => path.join(here, 'shims', name);

const bundle = async (): Promise<string> => {
    const result = await build({
        entryPoints: [path.join(here, 'page.ts')],
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'browser',
        target: 'es2022',
        logLevel: 'silent',
        alias: {
            'node:stream': 'readable-stream',
            stream: 'readable-stream',
            'node:events': 'events',
            'node:buffer': 'buffer',
            'node:string_decoder': 'string_decoder',
            'node:crypto': shim('crypto.js'),
            crypto: shim('crypto.js'),
            'node:zlib': shim('unsupported.js'),
            'node:net': shim('unsupported.js'),
            net: shim('unsupported.js'),
            'node:tls': shim('unsupported.js'),
            tls: shim('unsupported.js'),
            'node:dns': shim('unsupported.js'),
            dns: shim('unsupported.js'),
            path: shim('path.js')
        },
        inject: [shim('globals.js')],
        define: { global: 'globalThis' }
    });
    return result.outputFiles[0]!.text;
};

const launch = async (): Promise<Browser | string> => {
    try {
        return await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
    } catch (err: any) {
        return err.message.split('\n')[0];
    }
};

describe('Browser', { timeout: 5 * 60 * 1000 }, () => {
    let browser: Browser | null = null;
    let unavailable = '';
    let page: Page;
    let server: http.Server;
    const errors: string[] = [];

    const run = (scenario: PageScenario): Promise<PageResult> => page.evaluate(scenario => (globalThis as any).imapflowTest.run(scenario), scenario);

    before(async () => {
        // bundled first, so a missing shim fails the run even where Chrome is not available
        const code = await bundle();
        const launched = await launch();
        if (typeof launched === 'string') {
            unavailable = `Chrome is not available: ${launched}`;
            // CI has Chrome, a launch failure there is a broken setup, not a reason to skip
            assert.ok(!process.env.CI, unavailable);
            return;
        }
        browser = launched;
        // served from an http origin: module scripts do not run from about:blank
        server = http.createServer((request, response) => {
            if (request.url === '/page.js') {
                response.writeHead(200, { 'content-type': 'text/javascript' });
                response.end(code);
            } else {
                response.writeHead(200, { 'content-type': 'text/html' });
                response.end('<!doctype html><title>imapflow</title><script type="module" src="/page.js"></script>');
            }
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        page = await browser.newPage();
        page.on('pageerror', err => errors.push(err.message));
        await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
        await page.waitForFunction(() => (globalThis as any).imapflowTestReady === true, undefined, { timeout: 30 * 1000 });
    });

    after(async () => {
        await browser?.close();
        await new Promise(resolve => (server ? server.close(resolve) : resolve(undefined)));
    });

    const test = (name: string, fn: () => Promise<void>) =>
        it(name, async t => {
            if (!browser) {
                t.skip(unavailable);
                return;
            }
            errors.length = 0;
            await fn();
            assert.deepEqual(errors, [], 'no uncaught errors in the page');
        });

    test('runs in a page without Node.js globals', async () => {
        const globals = await page.evaluate(() =>
            [
                typeof (globalThis as any).process,
                typeof (globalThis as any).Buffer,
                typeof (globalThis as any).setImmediate,
                typeof (globalThis as any).require
            ].join()
        );
        assert.equal(globals, 'undefined,undefined,undefined,undefined');
    });

    test('runs the API tour through createStreamsTransport() with a STARTTLS upgrade', async () => {
        const result = await run({ transport: 'streams', tour: true, doSTARTTLS: true });
        assertTour(result);
        assert.equal(result.compressed, false, 'COMPRESS is skipped without streaming zlib');
        assert.equal(result.upgrades, 1, 'the connection was upgraded once');
        assert.equal(result.secureConnection, true);
        assert.ok(!result.capabilities?.includes('STARTTLS'), 'the capabilities were read again after the upgrade');
    });

    test('runs the API tour through a hand-written transport, hashing message ids with MD5', async () => {
        // without OBJECTID and X-GM-EXT-1 the id of a message is the MD5 of path:uidValidity:uid
        // (node:crypto shim)
        const plugins = ALL_PLUGINS.filter(plugin => !['COMPRESS', 'OBJECTID', 'X-GM-EXT-1'].includes(plugin));
        const result = await run({ transport: 'duplex', tour: true, secure: true, plugins });
        assertTour(result);
        assert.equal(result.secureConnection, true);
        const fetched = (result.tour as { fetchAll: Array<{ id: string }> }).fetchAll;
        assert.ok(
            fetched.every(message => /^[0-9a-f]{32}$/.test(message.id)),
            details(result)
        );
    });

    it('hashes like node:crypto in the MD5 shim', () => {
        for (const input of ['', 'abc', 'INBOX:1700000000:1', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), '\u00e9\u4e2d'.repeat(40)]) {
            assert.equal(md5Shim(input), nodeCrypto.createHash('md5').update(input).digest('hex'), JSON.stringify(input));
        }
    });

    test('skips STARTTLS when the transport can not upgrade', async () => {
        const result = await run({ transport: 'duplex', doSTARTTLS: undefined });
        assert.equal(result.ok, true, details(result));
        assert.equal(result.secureConnection, false);
        assert.ok(result.capabilities?.includes('STARTTLS'), 'the server offered STARTTLS');
        assert.ok(result.logs.some(line => line.includes('The transport can not start TLS')));
    });

    test('idles with the default pino logger and picks up a message the server adds', async () => {
        const result = await run({ transport: 'streams', secure: true, defaultLogger: true });
        assert.equal(result.ok, true, details(result));
        assert.deepEqual(result.steps, ['connect', 'idle', 'logout']);
        assert.equal(result.idle?.count, (result.idle?.prevCount || 0) + 1);
    });
});
