// The Worker that test/celld/celld-test.ts runs on celld (https://celld.dev). POST / runs a
// scenario of the Cloudflare Workers harness (test/cloudflare/worker.ts). The other routes
// cover what is specific to celld: which Node.js APIs ImapFlow needs exist, and how long a
// socket lives (celld closes a socket when the event that opened it ends).
//
// Like the Workers harness, it imports the built ES module output and is excluded from the
// project type-check.

import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import zlib from 'node:zlib';
import { runScenario, createClient, type Scenario, type ScenarioResult } from '../cloudflare/worker.js';

// Survives between requests only while celld keeps the isolate, which `celld dev` does for
// back-to-back requests
let held: { client: ReturnType<typeof createClient>; result: ScenarioResult } | null = null;
let background: ScenarioResult | null = null;

const attempt = (fn: () => unknown): string => {
    try {
        const value = fn();
        return 'ok: ' + typeof value;
    } catch (err: any) {
        return 'throws: ' + err.message;
    }
};

export default {
    async fetch(request: Request, _env: unknown, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
        const route = new URL(request.url).pathname;

        if (route === '/runtime') {
            return Response.json({
                'net.connect': attempt(() => net.connect({ host: '127.0.0.1', port: 9 }).on('error', () => false)),
                'net.isIP': attempt(() => net.isIP('127.0.0.1')),
                'tls.connect': attempt(() => tls.connect({ host: '127.0.0.1', port: 9 }).on('error', () => false)),
                'dns.lookup': attempt(() => dns.lookup('localhost', () => false)),
                'zlib.createDeflateRaw': typeof zlib.createDeflateRaw,
                'zlib.deflateRawSync': attempt(() => zlib.deflateRawSync(Buffer.from('x')))
            });
        }

        if (route === '/background' && request.method === 'GET') {
            return Response.json(background);
        }

        if (request.method !== 'POST') {
            return new Response('POST a scenario', { status: 405 });
        }
        const scenario = (await request.json()) as Scenario;

        if (route === '/') {
            return Response.json(await runScenario(scenario));
        }

        if (route === '/hold') {
            // Logs in and returns while the session is still open
            const result: ScenarioResult = { ok: false, steps: [], logs: [] };
            const client = createClient(scenario, result);
            try {
                await client.connect();
                await client.noop();
                result.steps.push('connect');
                result.ok = true;
                held = { client, result };
            } catch (err: any) {
                result.error = { message: err.message, code: err.code };
            }
            return Response.json(result);
        }

        if (route === '/reuse') {
            // Runs a command on the session a previous request opened
            if (!held) {
                return Response.json({ ok: false, steps: [], logs: [], error: { message: 'no held session, the isolate was replaced' } });
            }
            const { client, result } = held;
            held = null;
            result.steps = [];
            result.logs.push('--- reuse');
            const usable = client.usable;
            try {
                await client.noop();
                result.steps.push('noop');
                await client.logout();
                result.ok = true;
            } catch (err: any) {
                result.ok = false;
                result.error = { message: err.message, code: err.code };
                client.close();
            }
            return Response.json({ ...result, usable });
        }

        if (route === '/background') {
            // The session runs in waitUntil() after the response went out
            background = null;
            ctx.waitUntil(
                (async () => {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    background = await runScenario(scenario);
                })()
            );
            return Response.json({ started: true });
        }

        return new Response('Unknown route', { status: 404 });
    }
};
