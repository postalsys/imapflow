// The connect() of the cloudflare:sockets API implemented over node:net and node:tls, for
// testing createSocketsTransport() on Node. It has the restriction celld has: startTls() on a
// socket with a read in flight never completes, which the shim reports as an error instead of
// a hang.

import net from 'node:net';
import tls from 'node:tls';
import type { SocketsApiSocket, SocketsConnect } from '../../src/imap-flow.js';

export interface ShimState {
    // set by a test to make the next connect() throw
    throwOnConnect?: Error | undefined;
    startTlsCalls: number;
}

const wrap = (socket: net.Socket, connectEvent: 'connect' | 'secureConnect', state: ShimState): SocketsApiSocket => {
    let readPending = false;
    let readableController!: ReadableStreamDefaultController<Uint8Array>;
    const onData = (data: Buffer) => {
        readPending = false;
        readableController.enqueue(new Uint8Array(data));
    };
    const onEnd = () => readableController.close();
    const onError = (err: Error) => readableController.error(err);

    const readable = new ReadableStream<Uint8Array>(
        {
            start(controller) {
                readableController = controller;
                socket.on('data', onData);
                socket.once('end', onEnd);
                socket.once('error', onError);
            },
            pull() {
                // called with an empty queue, so a read is now waiting for the network
                readPending = true;
            }
        },
        { highWaterMark: 0 }
    );
    const writable = new WritableStream<Uint8Array>({
        write: chunk => new Promise<void>((resolve, reject) => socket.write(chunk, err => (err ? reject(err) : resolve())))
    });

    const opened = new Promise<{ remoteAddress: string; localAddress: string }>((resolve, reject) => {
        socket.once(connectEvent, () =>
            resolve({ remoteAddress: `${socket.remoteAddress}:${socket.remotePort}`, localAddress: `${socket.localAddress}:${socket.localPort}` })
        );
        socket.once('error', reject);
    });
    opened.catch(() => false);
    const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));

    return {
        readable,
        writable,
        opened,
        closed,
        close: async () => {
            socket.destroy();
        },
        startTls: () => {
            state.startTlsCalls++;
            socket.removeListener('data', onData);
            socket.removeListener('end', onEnd);
            socket.removeListener('error', onError);
            // the read in flight on the cleartext socket ends
            readableController.close();
            if (readPending) {
                const failed = new net.Socket();
                const shim = wrap(failed, 'secureConnect', state);
                setImmediate(() => failed.destroy(new Error('startTls() with a read in flight')));
                return shim;
            }
            return wrap(tls.connect({ socket, rejectUnauthorized: false }), 'secureConnect', state);
        }
    };
};

export const createShim =
    (state: ShimState): SocketsConnect =>
    (address, options) => {
        if (state.throwOnConnect) {
            throw state.throwOnConnect;
        }
        return options?.secureTransport === 'on'
            ? wrap(tls.connect({ host: address.hostname, port: address.port, rejectUnauthorized: false }), 'secureConnect', state)
            : wrap(net.connect({ host: address.hostname, port: address.port }), 'connect', state);
    };
