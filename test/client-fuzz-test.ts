import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, listen, makeClient } from './fixtures/scripted-server.js';
import { installRejectionDetector } from './fixtures/test-client.js';
import { FUZZ_ITERATIONS, FUZZ_SEED, Rng, generateResponse, mutate } from './fixtures/imap-fuzz.js';

// Seeded fuzzing of a whole client session. The server answers the session setup normally and
// then answers NOOP with generated, corrupted and truncated responses, sometimes with a wrong or
// missing tagged completion or a dropped connection. Whatever it sends:
//   * nothing escapes as an unhandled rejection
//   * the pending command settles, on its own or at the latest when the client is closed
//   * a client that settled the command cleanly can still run the next one
//
// Reproduce a failure with FUZZ_SEED=<seed> FUZZ_ITERATIONS=<n>, using the case number in the
// message.

const ITERATIONS = Math.max(1, Math.ceil(FUZZ_ITERATIONS / 5));

// Resolves with the settled state of the promise, or 'pending' after `ms`
const settle = <T>(promise: Promise<T>, ms: number): Promise<{ state: 'resolved' | 'rejected' | 'pending'; error?: any }> => {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
        promise.then(
            () => ({ state: 'resolved' as const }),
            error => ({ state: 'rejected' as const, error })
        ),
        new Promise<{ state: 'pending' }>(resolve => {
            timer = setTimeout(() => resolve({ state: 'pending' }), ms);
        })
    ]).finally(() => clearTimeout(timer));
};

describe('client fuzzing', () => {
    it('survives hostile responses to a command', async () => {
        const rng = new Rng(FUZZ_SEED + 100);
        // The case currently being played, read by the NOOP handler of the shared server
        let script: (ctx: any) => void = ctx => ctx.ok('NOOP completed');
        const server = createServer({
            handlers: {
                NOOP: (ctx: any) => script(ctx)
            }
        });
        const port = await listen(server);

        try {
            for (let n = 0; n < ITERATIONS; n++) {
                const lines: Buffer[] = [];
                const count = rng.int(1, 6);
                for (let i = 0; i < count; i++) {
                    const { wire } = generateResponse(rng);
                    lines.push(rng.chance(0.5) ? mutate(rng, wire) : wire);
                }
                // how the command ends: tagged OK, tagged NO, a corrupted completion, no
                // completion at all, or the server dropping the connection
                const ending = rng.int(0, 4);
                // drawn up front so a case replays the same whatever the client does
                const corruptCompletion = mutate(rng, Buffer.from(' OK NOOP completed'));
                if (process.env.FUZZ_CASE && Number(process.env.FUZZ_CASE) !== n) {
                    continue;
                }
                const context = `seed ${FUZZ_SEED + 100} case ${n} ending ${ending} ${JSON.stringify(Buffer.concat(lines).toString('latin1').slice(0, 300))}`;

                script = ctx => {
                    // the corrupted lines are written in one go so framing sees them together
                    const payload = Buffer.concat(lines.flatMap(line => [line, Buffer.from('\r\n')]));
                    ctx.socket.write(payload);
                    if (ending === 0) {
                        ctx.ok('NOOP completed');
                    } else if (ending === 1) {
                        ctx.no('NOOP failed');
                    } else if (ending === 2) {
                        ctx.write(Buffer.concat([Buffer.from(ctx.tag), corruptCompletion, Buffer.from('\r\n')]));
                    } else if (ending === 4) {
                        ctx.socket.destroy();
                    }
                };

                const detector = installRejectionDetector();
                const client = makeClient(port, { socketTimeout: 60 * 1000, ...(process.env.FUZZ_CASE ? { logger: undefined, logRaw: true } : {}) });
                client.on('error', () => {});
                try {
                    await client.connect();
                    await client.mailboxOpen('INBOX');

                    const noop = client.noop();
                    // On loopback a completion arrives within a few milliseconds. A command still pending
                    // after that is closed out, which is checked the same way, so a short wait is not flaky
                    let result = await settle(noop, 30);
                    if (result.state === 'pending') {
                        // no usable completion arrived: close() must settle the command
                        client.close();
                        result = await settle(noop, 2000);
                        assert.notEqual(result.state, 'pending', `${context}: close() left the command pending`);
                    }

                    if (result.state === 'rejected') {
                        assert.ok(result.error instanceof Error, `${context}: rejected with a non-Error`);
                    }

                    if (client.usable) {
                        // The session survived the garbage, so the next command must complete.
                        // The one exception is a corrupted literal marker: the stream then
                        // waits for literal bytes that never come and reads the completion as
                        // literal content, as the framing requires. close() must settle it then
                        script = ctx => ctx.ok('NOOP completed');
                        const awaitingLiteral = (client as any).streamer.literalWaiting > 0;
                        const nextCommand = client.noop();
                        let next = await settle(nextCommand, awaitingLiteral ? 30 : 2000);
                        if (next.state === 'pending' && awaitingLiteral) {
                            client.close();
                            next = await settle(nextCommand, 2000);
                        }
                        assert.notEqual(next.state, 'pending', `${context}: the next command did not settle`);
                    }
                } finally {
                    client.close();
                    // let close() and any late socket events run before checking for rejections
                    await new Promise(resolve => setImmediate(resolve));
                    detector.check();
                }
            }
        } finally {
            server.close();
        }
    });
});
