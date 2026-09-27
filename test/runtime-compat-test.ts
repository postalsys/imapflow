import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { makeClient, makeSocketStub } from './fixtures/test-client.js';
import { ImapStream } from '../src/handler/imap-stream.js';

// Behavior that differs between JavaScript runtimes. The library runs on Node.js, Bun and
// Cloudflare Workers, and these cases pin the spots where a runtime detail (event ordering,
// missing socket features) would otherwise make a session stall or fail on one of them.

describe('runtime-compat', () => {
    it('Runtime: the reader restarts for a response pushed while the loop was winding down', async () => {
        // On Node.js a stream emits 'readable' on the next tick, after the reader loop's
        // finally handler has cleared the `reading` guard. On Cloudflare Workers nextTick is a
        // microtask, so the event fires while the guard is still set and is ignored; the
        // response then stays in the parser buffer. The guard has to re-check the buffer.
        const client = makeClient();
        client.setEventHandlers();
        // Node's own 'readable' emission is taken out of the picture, so only the early event
        // simulated below and the re-check after the loop can start the reader
        client.streamer.removeListener('readable', client.socketReadable);

        let calls = 0;
        client.reader = async () => {
            calls++;
            if (calls === 1) {
                // a response arrives while the loop is still running, and the runtime reports
                // it before the loop has wound down
                client.streamer.push({ payload: Buffer.from('* OK later'), literals: [], next: () => {}, trailingAfterLine: false });
                client.socketReadable();
                return;
            }
            // the restarted loop drains what was pushed
            while (client.streamer.read() !== null) {
                // drain
            }
        };

        client.socketReadable();
        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setImmediate(resolve));

        assert.equal(calls, 2, 'the buffered response was read by a second reader run');
        assert.equal(client.reading, false);
        client.close();
    });

    it('Runtime: a drained parser does not restart the reader', async () => {
        const client = makeClient();
        client.setEventHandlers();
        client.streamer.removeListener('readable', client.socketReadable);

        let calls = 0;
        client.reader = async () => {
            calls++;
        };

        client.socketReadable();
        await new Promise(resolve => setImmediate(resolve));

        assert.equal(calls, 1);
        assert.equal(client.reading, false);
        client.close();
    });
});

describe('runtime-compat: input stream', () => {
    it('Runtime: a chunk delivered while the input loop is winding down is still processed', async () => {
        // Cloudflare Workers hand over the next socket chunk in the microtasks between the
        // input loop finding its queue empty and the loop's promise settling (issue #408)
        const stream = new ImapStream();
        const lines: string[] = [];
        stream.on('readable', () => {
            let item;
            while ((item = stream.read()) !== null) {
                lines.push(item.payload.toString());
                item.next();
            }
        });

        await new Promise<void>((resolve, reject) => {
            stream._transform(Buffer.from('* OK first\r\n'), 'utf-8', () => {
                // runs from the loop, before it re-checks the queue; the microtask lands after
                // the loop has found the queue empty but before its promise settles
                queueMicrotask(() => {
                    stream._transform(Buffer.from('* OK second\r\n'), 'utf-8', err => (err ? reject(err) : resolve()));
                });
            });
            setTimeout(() => reject(new Error('second chunk was never processed')), 1000).unref();
        });

        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(lines, ['* OK first', '* OK second']);
        assert.equal(stream.processingInput, false);
        stream.destroy();
    });

    it('Runtime: a parse failure clears the input loop guard and fails the stream', async () => {
        const stream = new ImapStream();
        const failure = new Error('parse failed');
        stream.processInputChunk = async () => {
            throw failure;
        };
        const errored = new Promise(resolve => stream.once('error', resolve));
        stream._transform(Buffer.from('* OK\r\n'), 'utf-8', () => {});
        assert.equal(await errored, failure);
        assert.equal(stream.processingInput, false);
        assert.equal(stream.destroyed, true);
    });
});

describe('runtime-compat: STARTTLS', () => {
    it('Runtime: a tls.connect() that throws settles the upgrade as a TLS failure', async t => {
        // Cloudflare Workers throw from tls.connect() for options their node:tls does not
        // implement, and for an upgrade the runtime can not perform. A throw inside the
        // upgrade promise's executor used to bypass settle(): the promise rejected with the
        // bare error, `upgrading` stayed set and the upgrade timer stayed armed.
        const client = makeClient({ secure: false });
        client.socket = makeSocketStub();
        client.socket.read = () => null;
        client.capabilities.set('STARTTLS', true);
        client.run = async (command: string) => command === 'STARTTLS';
        const refused = new Error('The options.rejectUnauthorized option is not implemented');
        t.mock.method(tls, 'connect', () => {
            throw refused;
        });
        t.after(() => t.mock.restoreAll());

        await assert.rejects(client.upgradeToSTARTTLS(), (err: any) => err === refused && err.tlsFailed === true);
        assert.equal(client.upgrading, false);
        assert.equal(client._upgradeReject, null);
        assert.equal(client.upgradeTimeout, null);
        assert.equal(client.secureConnection, false);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(client.isClosed, true, 'the connection was closed');
    });
});
