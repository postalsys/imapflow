import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { ImapFlow } from '../src/imap-flow.js';

// A connection reports at most one 'error' event. The socket error listener used to be a once()
// listener and the compression streams forwarded their errors onto the raw socket, so a second
// error before the deferred close() found no listener there and was thrown, crashing the host.

const makeSocket = () => {
    let socket: any = new EventEmitter();
    socket.pipe = (dest: any) => dest;
    socket.unpipe = () => {};
    socket.destroy = () => {
        socket.destroyed = true;
    };
    socket.destroyed = false;
    return socket;
};

const makeClient = async (compressed: boolean) => {
    let client: any = new ImapFlow({
        host: 'imap.example.com',
        port: 993,
        auth: { user: 'test', pass: 'test' },
        logger: false
    });
    client.socket = makeSocket();
    client.writeSocket = client.socket;
    client.usable = true;
    if (compressed) {
        client.run = async (command: string) => command === 'COMPRESS';
        await client.compress();
    }
    client.setSocketHandlers();

    let errors: Error[] = [];
    client.on('error', (err: Error) => errors.push(err));
    let closed = new Promise(resolve => client.once('close', resolve));
    return { client, errors, closed };
};

describe('emit-error-once', () => {
    it('two socket errors in a row emit one error event', async () => {
        let { client, errors, closed } = await makeClient(false);

        assert.doesNotThrow(() => client.socket.emit('error', new Error('first')));
        assert.doesNotThrow(() => client.socket.emit('error', new Error('second')), 'the second error finds a listener');

        await closed;
        assert.deepEqual(
            errors.map(err => err.message),
            ['first']
        );
        assert.equal(client.isClosed, true);
    });

    it('with compression, socket, deflate and writeSocket errors in a row emit one error event', async () => {
        let { client, errors, closed } = await makeClient(true);
        let deflate = client._deflate;
        let writeSocket = client.writeSocket;
        assert.notEqual(writeSocket, client.socket, 'compression replaced the write socket');

        assert.doesNotThrow(() => client.socket.emit('error', new Error('socket')));
        assert.doesNotThrow(() => deflate.emit('error', new Error('deflate')), 'a deflate error after the first error is absorbed');
        assert.doesNotThrow(() => writeSocket.emit('error', new Error('write')), 'a writeSocket error after the first error is absorbed');

        await closed;
        assert.deepEqual(
            errors.map(err => err.message),
            ['socket']
        );

        // after close() nothing reaches the client any more
        assert.doesNotThrow(() => deflate.emit('error', new Error('late deflate')));
        assert.doesNotThrow(() => writeSocket.emit('error', new Error('late write')));
        assert.equal(errors.length, 1);
    });

    it('with compression, a deflate error first is reported once', async () => {
        let { client, errors, closed } = await makeClient(true);
        let deflate = client._deflate;

        assert.doesNotThrow(() => deflate.emit('error', new Error('deflate')));
        assert.doesNotThrow(() => deflate.emit('error', new Error('deflate again')));
        assert.doesNotThrow(() => client.socket.emit('error', new Error('socket')));

        await closed;
        assert.deepEqual(
            errors.map(err => err.message),
            ['deflate']
        );
    });

    it('an error after connect() already rejected is not emitted', async () => {
        // connect() owns error reporting while it is pending; a caller that awaits it usually has
        // no 'error' listener, so a second error must not be emitted either
        let client: any = new ImapFlow({ host: 'imap.example.com', port: 993, auth: { user: 'test', pass: 'test' }, logger: false });
        client.socket = makeSocket();
        client.writeSocket = client.socket;
        let rejected: Error[] = [];
        client.initialReject = (err: Error) => rejected.push(err);
        client.initialResolve = () => {};
        client.setSocketHandlers();

        assert.doesNotThrow(() => client.socket.emit('error', new Error('first')));
        assert.equal(client.listenerCount('error'), 0);
        assert.doesNotThrow(() => client.emitError(new Error('second')), 'no unhandled error event');

        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(
            rejected.map(err => err.message),
            ['first']
        );
    });
});
