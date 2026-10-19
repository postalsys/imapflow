import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Heap budgets: a session runs in a child process whose V8 heap is capped with
// --max-old-space-size, so a response that costs many times its own size while it is parsed
// aborts the child with "heap out of memory" instead of passing unnoticed. The byte limits
// (maxLineLength, maxResponseSize) bound what a server sends, these tests bound what the client
// makes of it. The child loads the CommonJS build, so `npm test` (which builds first) covers it.
//
// A scenario is the body of an async function that gets `ImapFlow`, a `serve(handlers)` that
// starts an in-process server answering the commands in `handlers` (and a minimal session
// around them), and returns a JSON-serializable result for the test to check.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'dist', 'cjs', 'imap-flow.js');

const harness = `
const net = require('node:net');
const { ImapFlow } = require(${JSON.stringify(entry)});

const serve = handlers =>
    new Promise(resolve => {
        const server = net.createServer(socket => {
            socket.on('error', () => {});
            socket.write('* OK ready\\r\\n');
            let buf = '';
            socket.on('data', chunk => {
                buf += chunk.toString('latin1');
                let idx;
                while ((idx = buf.indexOf('\\r\\n')) >= 0) {
                    const line = buf.slice(0, idx);
                    buf = buf.slice(idx + 2);
                    const [tag, command = '', sub = ''] = line.split(' ');
                    const name = command.toUpperCase() === 'UID' ? sub.toUpperCase() : command.toUpperCase();
                    const ok = text => socket.write(tag + ' OK ' + (text || 'done') + '\\r\\n');
                    if (handlers[name]) {
                        handlers[name]({ socket, ok });
                    } else if (name === 'CAPABILITY') {
                        socket.write('* CAPABILITY IMAP4rev1\\r\\n');
                        ok();
                    } else if (name === 'SELECT' || name === 'EXAMINE') {
                        socket.write('* 1 EXISTS\\r\\n* OK [UIDVALIDITY 1] ok\\r\\n');
                        ok('[READ-WRITE] done');
                    } else {
                        ok();
                    }
                }
            });
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });

const run = async () => {
    const server = await serve(globalThis.handlers);
    const client = new ImapFlow({
        host: '127.0.0.1',
        port: server.address().port,
        secure: false,
        logger: false,
        disableAutoIdle: true,
        auth: { user: 'u', pass: 'p' }
    });
    client.on('error', () => {});
    try {
        await client.connect();
        return await globalThis.scenario(client);
    } finally {
        client.close();
        server.close();
    }
};
`;

/**
 * Runs a scenario in a child process with a capped heap.
 *
 * @param heapMiB - The --max-old-space-size value
 * @param setup - Code that defines `globalThis.handlers` and `globalThis.scenario`
 * @returns The scenario's result, parsed from the child's output
 */
const runCapped = (heapMiB: number, setup: string): unknown => {
    const script = `${harness}\n${setup}\nrun().then(result => process.stdout.write(JSON.stringify(result)), err => { console.error(err); process.exit(2); });`;
    const result = spawnSync(process.execPath, [`--max-old-space-size=${heapMiB}`, '-e', script], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.equal(result.status, 0, `child failed (status ${result.status}, signal ${result.signal}): ${result.stderr.slice(-2000)}`);
    return JSON.parse(result.stdout);
};

describe('heap budgets', { skip: process.versions.bun ? '--max-old-space-size is a V8 flag' : false }, () => {
    // A SEARCH answer is one number per matching message. Read as one token object each it took
    // some 30 times the line size in heap, so 1M UIDs (an 8 MB line) needed over 200 MB (#443)
    it('a SEARCH answer of 1M UIDs fits in a 64 MB heap', () => {
        assert.ok(fs.existsSync(entry), `${entry} is missing, run "npm run build" before this test`);
        const result = runCapped(
            64,
            `
            const COUNT = 1000000;
            globalThis.handlers = {
                SEARCH({ socket, ok }) {
                    // written in chunks, so the server side does not hold the whole line as one string
                    let uid = 1000000;
                    for (let sent = 0; sent < COUNT; ) {
                        const parts = [];
                        for (let i = 0; i < 50000 && sent < COUNT; i++, sent++) {
                            parts.push(uid);
                            uid += 2;
                        }
                        socket.write((sent === parts.length ? '* SEARCH ' : ' ') + parts.join(' '));
                    }
                    socket.write('\\r\\n');
                    ok();
                }
            };
            globalThis.scenario = async client => {
                await client.mailboxOpen('INBOX');
                const uids = await client.search({ all: true }, { uid: true });
                return { length: uids.length, first: uids[0], last: uids[uids.length - 1] };
            };
            `
        );
        assert.deepEqual(result, { length: 1000000, first: 1000000, last: 1000000 + 2 * 999999 });
    });
});
