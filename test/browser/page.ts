// The page test/browser/browser-test.ts loads in headless Chrome. Bundled by esbuild together with
// the built ES module output of ImapFlow and the browser build of ImapKit, with the Node.js
// builtins replaced by the shims in shims/. There are no sockets in a browser: sessions run over
// in-memory connections to an ImapKit server in the same page, through the transport option.
//
// Excluded from the project type-check like the Workers harness, it imports the build output.

import { Duplex } from 'node:stream';
import imapkit from 'imapkit/browser';
import { ImapFlow, createStreamsTransport, type ImapTransport, type StreamsSocket } from '../../dist/esm/imap-flow.js';
import { ALL_PLUGINS, DEFAULT_STORAGE } from '../fixtures/imapkit-config.js';
import { runTour } from '../fixtures/api-tour.js';
import type { PageResult, PageScenario } from './types.js';

type ImapKitServer = ReturnType<typeof imapkit>;
type MemorySocket = ReturnType<ImapKitServer['connect']>;

// A MemorySocket as a web streams socket. `detach()` stops feeding the readable stream, for the
// upgrade that hands the connection to a new one
interface MemoryStreamsSocket extends StreamsSocket {
    mem: MemorySocket;
    detach(): void;
}

const memoryStreams = (mem: MemorySocket, ready: Promise<void>): MemoryStreamsSocket => {
    let detach = () => {};
    const readable = new ReadableStream<Uint8Array>({
        start(controller) {
            let finished = false;
            const onData = (data: Uint8Array) => controller.enqueue(new Uint8Array(data));
            const onEnd = () => {
                if (!finished) {
                    finished = true;
                    controller.close();
                }
            };
            const onError = (err: Error) => {
                if (!finished) {
                    finished = true;
                    controller.error(err);
                }
            };
            mem.on('data', onData);
            mem.on('end', onEnd);
            mem.on('close', onEnd);
            mem.on('error', onError);
            detach = () => {
                mem.off('data', onData);
                mem.off('end', onEnd);
                mem.off('close', onEnd);
                mem.off('error', onError);
            };
        }
    });
    const writable = new WritableStream<Uint8Array>({
        write: chunk => new Promise<void>(resolve => mem.write(chunk, () => resolve()))
    });
    return {
        mem,
        detach: () => detach(),
        opened: ready.then(() => ({ readable, writable, remoteAddress: 'memory' })),
        close: () => mem.destroy()
    };
};

const streamsTransport = (server: ImapKitServer, counter: { upgrades: number }): ImapTransport =>
    createStreamsTransport<MemoryStreamsSocket>({
        open: ({ secure }) => memoryStreams(server.connect({ secure }), Promise.resolve()),
        upgrade: socket => {
            counter.upgrades++;
            socket.detach();
            // ImapKit's STARTTLS without TLS: the connection counts as encrypted once both ends switched
            return memoryStreams(socket.mem, new Promise<void>(resolve => socket.mem.startTls(resolve)));
        }
    });

// The transport option without the helper: a Duplex over a MemorySocket with the inactivity
// timeout ImapFlow arms, and no upgrade
const duplexTransport = (server: ImapKitServer): ImapTransport => ({
    connect({ secure }, onConnect) {
        const mem = server.connect({ secure });
        let timer: ReturnType<typeof setTimeout> | undefined;
        let timeout = 0;
        const touch = (target: Duplex) => {
            clearTimeout(timer);
            if (timeout > 0) {
                timer = setTimeout(() => target.emit('timeout'), timeout);
            }
        };
        const duplex = new Duplex({
            read() {},
            write(chunk, _encoding, callback) {
                touch(this);
                mem.write(chunk, () => callback());
            },
            final(callback) {
                mem.end();
                callback();
            },
            destroy(err, callback) {
                clearTimeout(timer);
                mem.destroy();
                callback(err);
            }
        });
        const socket = Object.assign(duplex, {
            setTimeout(ms: number) {
                timeout = ms;
                touch(duplex);
                return duplex;
            }
        });
        mem.on('data', (data: Uint8Array) => {
            touch(socket);
            socket.push(data);
        });
        mem.on('end', () => socket.push(null));
        mem.on('close', () => socket.destroy());
        queueMicrotask(onConnect);
        return socket;
    }
});

const run = async (scenario: PageScenario): Promise<PageResult> => {
    const result: PageResult = { ok: false, steps: [], upgrades: 0, logs: [] };
    const server = imapkit({ plugins: scenario.plugins || ALL_PLUGINS.filter(plugin => plugin !== 'COMPRESS'), storage: DEFAULT_STORAGE });
    const client = new ImapFlow({
        host: 'imapkit.invalid',
        port: 143,
        secure: !!scenario.secure,
        doSTARTTLS: scenario.doSTARTTLS,
        auth: { user: 'testuser', pass: 'testpass' },
        transport: scenario.transport === 'streams' ? streamsTransport(server, result) : duplexTransport(server),
        logger: scenario.defaultLogger ? undefined : false,
        emitLogs: true,
        disableAutoIdle: true,
        clientInfo: { name: 'imapflow-browser-test' }
    });
    client.on('log', entry => {
        result.logs.push(`${entry.level}: ${entry.src ? entry.src + ' ' : ''}${entry.msg || ''}${entry.err ? ' ' + (entry.err.message || entry.err) : ''}`);
    });
    client.on('error', err => result.logs.push('error event: ' + err.message));

    try {
        try {
            await client.connect();
        } finally {
            result.secureConnection = client.secureConnection;
            result.capabilities = Array.from(client.capabilities.keys());
        }
        result.steps.push('connect');
        result.compressed = !!(client as unknown as { _deflate?: unknown })._deflate;

        if (scenario.tour) {
            await runTour(client, result);
        } else {
            const lock = await client.getMailboxLock('INBOX');
            try {
                const exists = new Promise<{ count: number; prevCount: number }>(resolve => client.once('exists', resolve));
                const idling = client.idle();
                // the server adds the message once the session is idling
                const waiting = (event: any) => {
                    if (event.type === 'waiting' && event.command === 'IDLE') {
                        server.off('session', waiting);
                        server.control.addMessage('INBOX', { raw: 'Subject: pushed\r\n\r\nHello\r\n' });
                    }
                };
                server.on('session', waiting);
                const event = await Promise.race([
                    exists,
                    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('no EXISTS while idling')), 10 * 1000))
                ]);
                await client.noop();
                await idling;
                result.idle = { count: event.count, prevCount: event.prevCount };
                result.steps.push('idle');
            } finally {
                lock.release();
            }
        }

        await client.logout();
        result.steps.push('logout');
        result.ok = true;
    } catch (err: any) {
        result.error = { message: err.message, code: err.code, tlsFailed: err.tlsFailed };
        client.close();
    } finally {
        server.close();
    }
    return result;
};

(globalThis as any).imapflowTest = { run };
(globalThis as any).imapflowTestReady = true;
