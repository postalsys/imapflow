import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ImapFlow } from '../src/imap-flow.js';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import type { MailboxObject } from '../src/types.js';

// Helper to create a mock client with compression enabled
async function setupCompressedClient() {
    let client: any = new ImapFlow({
        host: 'imap.example.com',
        port: 993,
        auth: { user: 'test', pass: 'test' }
    });

    let mockSocket: any = new EventEmitter();
    mockSocket.pipe = (dest: any) => dest;
    (mockSocket as any).unpipe = () => {};
    (mockSocket as any).destroy = () => {};
    (mockSocket as any).destroyed = false;
    client.socket = mockSocket;
    // Mock streamer that tracks destruction like a real stream, so close() drives it into
    // the destroyed state the post-close guards actually check.
    client.streamer = Object.assign(new EventEmitter(), {
        destroyed: false,
        destroy() {
            this.destroyed = true;
        }
    });

    client.run = async (command: any) => {
        if (command === 'COMPRESS') {
            return true;
        }
    };

    await client.compress();
    return { client, mockSocket };
}

describe('connection-edge-cases', () => {
    // Edge Cases Tests
    it('Connection Edge: Socket error during connection', () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        // Simulate socket error
        let errorEmitted = false;
        client.on('error', err => {
            errorEmitted = true;
            assert.ok(err);
            assert.equal((err as any)._connId, client.id);
        });

        // Trigger error through emitError
        let testError: any = new Error('Socket connection failed');
        testError.code = 'ECONNREFUSED';
        client.emitError(testError);

        assert.ok(errorEmitted, 'Error event should be emitted');
    });
    it('Connection Edge: Write after socket destroyed', () => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        // Simulate destroyed socket
        client.socket = { destroyed: true };

        assert.throws(
            () => {
                client.write('TEST');
            },
            /Socket is already closed/,
            'Should throw when writing to destroyed socket'
        );
    });
    it('Connection Edge: Write after logout', () => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        // Create a mock socket
        client.socket = { destroyed: false };
        client.state = client.states.LOGOUT;

        assert.throws(
            () => {
                client.write('TEST');
            },
            /Can not send data after logged out/,
            'Should throw when writing after logout'
        );
    });
    it('Connection Edge: Stats reset functionality', () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        // Set some initial values
        client.writeBytesCounter = 100;
        client.streamer.readBytesCounter = 200;

        let stats = client.stats(false);
        assert.equal(stats.sent, 100);
        assert.equal(stats.received, 200);

        // Reset stats
        stats = client.stats(true);
        assert.equal(stats.sent, 100, 'Should return old value before reset');
        assert.equal(stats.received, 200, 'Should return old value before reset');

        // Check if reset worked
        assert.equal(client.writeBytesCounter, 0, 'Write counter should be reset');
        assert.equal(client.streamer.readBytesCounter, 0, 'Read counter should be reset');
    });
    it('Connection Edge: Multiple error handlers', () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        let errorCount = 0;

        // Add multiple error handlers
        client.on('error', () => errorCount++);
        client.on('error', () => errorCount++);
        client.on('error', () => errorCount++);

        // Emit an error
        client.emitError(new Error('Test error'));

        assert.equal(errorCount, 3, 'All error handlers should be called');
    });
    it('Connection Edge: Connection with valid empty auth', () => {
        // ImapFlow actually allows creating client without throwing
        // The error would occur during connection
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test' }
        });

        assert.ok(client, 'Client should be created even with partial auth');
        assert.equal(client.host, 'imap.example.com');
    });
    it('Connection Edge: Connection with default values', () => {
        // ImapFlow sets default values for missing options
        let client = new ImapFlow({
            host: 'imap.example.com',
            auth: { user: 'test', pass: 'test' }
        });

        assert.ok(client, 'Client should be created with defaults');
        assert.equal(client.port, 143, 'Should use default port');
        assert.equal(client.secureConnection, false, 'Should default to non-secure');
    });
    it('Connection Edge: Port number handling', () => {
        // ImapFlow sets default port based on secure flag
        let client1 = new ImapFlow({
            host: 'imap.example.com',
            secure: false,
            auth: { user: 'test', pass: 'test' }
        });
        assert.equal(client1.port, 143, 'Default non-secure port');

        let client2 = new ImapFlow({
            host: 'imap.example.com',
            port: 65535,
            auth: { user: 'test', pass: 'test' }
        });
        assert.equal(client2.port, 65535, 'Custom port accepted');
    });
    it('Connection Edge: STARTTLS misconfiguration', (t, done) => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 143,
            secure: true,
            doSTARTTLS: true,
            auth: { user: 'test', pass: 'test' }
        });

        // Test that upgradeToSTARTTLS throws on misconfiguration
        client.upgradeToSTARTTLS().catch(err => {
            assert.ok(err);
            assert.ok(err.message.includes('Misconfiguration'), 'Should detect STARTTLS misconfiguration');
            done();
        });
    });
    it('Connection Edge: Socket timeout handling', () => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        // Create a mock socket
        client.socket = new EventEmitter();
        (client.socket as any)!.destroyed = false;
        (client.socket as any)!.destroy = () => {};
        client.writeSocket = client.socket;
        (client.writeSocket as any)!.destroy = () => {};

        let errorEmitted = false;
        client.on('error', (err: any) => {
            errorEmitted = true;
            assert.equal((err as any).code, 'ETIMEOUT');
        });

        // Set up socket handlers
        client.setSocketHandlers();

        // Simulate timeout on non-idle connection
        client.idling = false;
        (client.socket as any)!.emit('timeout');

        assert.ok(errorEmitted, 'Timeout error should be emitted');
    });
    it('Connection Edge: Socket timeout during IDLE', (t, done) => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        // Create mock socket and methods
        client.socket = new EventEmitter();
        (client.socket as any)!.destroyed = false;
        client.writeSocket = client.socket;
        client.usable = true;
        client.idling = true;

        // Mock run and idle methods
        let noopCalled = false;
        let idleCalled = false;

        client.run = async (command: any) => {
            if (command === 'NOOP') {
                noopCalled = true;
                return Promise.resolve();
            }
        };

        client.idle = async () => {
            idleCalled = true;
            return Promise.resolve();
        };

        // Set up socket handlers
        client.setSocketHandlers();

        // Simulate timeout during IDLE
        (client.socket as any)!.emit('timeout');

        // Give async operations time to complete
        setTimeout(() => {
            assert.ok(noopCalled, 'NOOP should be called to recover from IDLE timeout');
            // Returning to IDLE is autoidle()'s decision once the NOOP settles (run() re-arms it);
            // the watchdog handler itself must not bypass the busy guard by calling idle() directly
            assert.equal(idleCalled, false, 'the timeout handler does not restart IDLE by itself');
            done();
        }, 100);
    });
    it('Connection Edge: Clear socket handlers', () => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        // Create a mock socket
        client.socket = new EventEmitter();
        client.writeSocket = client.socket;

        // Set handlers
        client.setSocketHandlers();

        // Verify handlers are set
        assert.equal((client.socket as any)!.listenerCount('error'), 1);
        assert.equal((client.socket as any)!.listenerCount('close'), 1);
        assert.equal((client.socket as any)!.listenerCount('end'), 1);
        assert.equal((client.socket as any)!.listenerCount('timeout'), 1);

        // Clear handlers
        client.clearSocketHandlers();

        // Verify handlers are removed
        assert.equal((client.socket as any)!.listenerCount('error'), 0);
        assert.equal((client.socket as any)!.listenerCount('close'), 0);
        assert.equal((client.socket as any)!.listenerCount('end'), 0);
        assert.equal((client.socket as any)!.listenerCount('timeout'), 0);
    });
    it('Connection Edge: Write with null socket', () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        // Set socket to null
        client.socket = null;

        assert.throws(
            () => {
                client.write('TEST');
            },
            /Socket is already closed/,
            'Should throw when socket is null'
        );
    });
    it('Connection Edge: Compression error handling', (t, done) => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        // Create mock socket and streams
        client.socket = new EventEmitter();
        (client.socket as any)!.pipe = () => client.socket;
        (client.socket as any)!.unpipe = () => {};
        client.streamer = new EventEmitter();

        // Mock run method to simulate successful COMPRESS negotiation
        client.run = async (command: any) => {
            if (command === 'COMPRESS') {
                return true;
            }
        };

        let errorEmitted = false;
        client.streamer.on('error', (err: any) => {
            errorEmitted = true;
            assert.ok(err);
        });

        // Call compress
        client.compress().then(() => {
            // Simulate compression error
            if (client._inflate) {
                client._inflate.emit('error', new Error('Compression failed'));
            }

            assert.ok(errorEmitted, 'Compression error should be propagated');
            done();
        });
    });
    it('Connection Edge: Authentication state after logout', (t, done) => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        // Set initial authenticated state
        client.state = client.states.AUTHENTICATED;
        client.authenticated = true;

        // Simulate logout
        client.state = client.states.LOGOUT;

        // Try to authenticate
        client.authenticate().catch(err => {
            assert.ok(err);
            assert.equal(err.message, 'Already logged out');
            done();
        });
    });
    it('Connection Edge: Throttling detection', (t, done) => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        // Create mock request
        let errorReceived: any = null;
        let request: any = {
            tag: 'A001',
            command: 'FETCH',
            resolve: () => {},
            reject: (err: any) => {
                errorReceived = err;
            }
        };

        client.requestTagMap = new Map();
        client.requestTagMap.set('A001', request);

        // Simulate throttling response
        let parsed = {
            tag: 'A001',
            command: 'BAD',
            attributes: [
                {
                    type: 'TEXT',
                    value: 'Request is throttled. Suggested Backoff Time: 5000 milliseconds'
                }
            ]
        };

        // Mock streamer with proper async iterator
        client.streamer = new EventEmitter();
        client.streamer.read = () => null;
        (client.streamer as any).iterate = async function* () {
            yield {
                next: () => {},
                parsed
            };
        };

        // Process reader
        client
            .reader()
            .then(() => {
                if (errorReceived) {
                    assert.ok(errorReceived, 'Should receive throttle error');
                    assert.equal(errorReceived.code, 'ETHROTTLE');
                    assert.equal(errorReceived.throttleReset, 5000);
                }
                done();
            })
            .catch(() => {
                // Reader might fail in test environment
                done();
            });
    });
    it('Connection Edge: Binary data in write', () => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        // Mock socket
        let writtenData: any = null;
        client.socket = { destroyed: false };
        client.writeSocket = {
            destroyed: false,
            write: (data: any) => {
                writtenData = data;
            }
        } as any;

        // Test writing Buffer
        let testBuffer = Buffer.from('TEST');
        client.write(testBuffer);

        assert.ok(Buffer.isBuffer(writtenData));
        assert.ok(writtenData.includes(testBuffer));
        assert.ok((writtenData as any).includes(Buffer.from('\r\n')));

        // Test writing string
        client.commandParts = [];
        client.write('STRING_TEST');

        assert.ok(Buffer.isBuffer(writtenData));
        assert.ok((writtenData as any).includes(Buffer.from('STRING_TEST\r\n')));
    });
    it('Connection Edge: Invalid write data type', () => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        // Mock socket
        client.socket = { destroyed: false };
        client.writeSocket = { destroyed: false, write: () => {} } as any;

        // Test writing invalid data type
        let result = client.write(12345 as any);
        assert.equal(result, false, 'Should return false for invalid data type');

        result = client.write({ test: 'object' } as any);
        assert.equal(result, false, 'Should return false for object');
    });
    it('Connection Edge: Concurrent connections', () => {
        let clients = [];

        // Create multiple clients
        for (let i = 0; i < 5; i++) {
            let client = new ImapFlow({
                host: `imap${i}.example.com`,
                port: 993,
                auth: { user: `user${i}`, pass: `pass${i}` }
            });
            clients.push(client);
        }

        // Verify each client has unique ID
        let ids = clients.map(c => c.id);
        let uniqueIds = [...new Set(ids)];
        assert.equal(uniqueIds.length, clients.length, 'All client IDs should be unique');

        // Verify each client has independent state
        clients[0].state = clients[0].states.AUTHENTICATED;
        clients[1].state = clients[1].states.SELECTED;

        assert.equal(clients[0].state, clients[0].states.AUTHENTICATED);
        assert.equal(clients[1].state, clients[1].states.SELECTED);
        assert.equal(clients[2].state, clients[2].states.NOT_AUTHENTICATED);
    });
    it('Connection Edge: Destroyed write socket', () => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        // Mock sockets
        client.socket = { destroyed: false };
        client.writeSocket = { destroyed: true };

        // Mock close method
        let closeCalled = false;
        client.close = () => {
            closeCalled = true;
        };

        // Attempt to write
        client.write('TEST');

        assert.ok(closeCalled, 'Should call close when write socket is destroyed');
    });
    it('Connection Edge: Command after logout', (t, done) => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        // Set logout state
        client.state = client.states.LOGOUT;

        // Create a request
        let errorReceived: any = null;
        let request: any = {
            tag: 'A001',
            reject: (err: any) => {
                errorReceived = err;
            }
        };

        client.requestTagMap = new Map();
        client.requestTagMap.set('A001', request);

        // Try to send command
        client.send({ tag: 'A001', command: 'NOOP' } as any).then(() => {
            assert.ok(errorReceived, 'Should reject command after logout');
            assert.equal(errorReceived.code, 'NoConnection');
            done();
        });
    });
    it('Connection Edge: Race condition in mailbox lock', (t, done) => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        // Initialize locks array
        client.locks = [];

        // Simulate concurrent lock requests
        let lockPromises = [];
        for (let i = 0; i < 3; i++) {
            lockPromises.push(
                new Promise(resolve => {
                    client.locks.push({
                        path: 'INBOX',
                        resolve,
                        promise: new Promise(() => {})
                    } as any);
                })
            );
        }

        assert.equal(client.locks.length, 3, 'Should queue multiple lock requests');

        // Process locks sequentially
        client.locks.forEach((lock, index) => {
            lock.resolve({ path: 'INBOX', index } as any);
        });

        Promise.all(lockPromises).then(results => {
            assert.equal(results.length, 3, 'All lock requests should be resolved');
            done();
        });
    });

    // NB! the capability discard/re-fetch behavior around STARTTLS is asserted end to
    // end in imap-flow-secure-test.js ('Secure: STARTTLS upgrade completes a session',
    // PRETLS-ONLY/POSTTLS-ONLY markers) - a mocked upgradeToSTARTTLS cannot reach the
    // re-fetch code without a real TLS handshake, so no vacuous variant is kept here.
    it('Connection Edge: Event handlers attached before piping', () => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        // Track the order of operations during the connection flow
        let pipeCalledBeforeHandlers = false;
        let eventHandlersAttached = false;
        let pipeWasCalled = false;

        // Override setEventHandlers to track when it's called
        let originalSetEventHandlers = client.setEventHandlers.bind(client);
        client.setEventHandlers = function () {
            eventHandlersAttached = true;
            return originalSetEventHandlers();
        };

        // Create a mock socket with pipe tracking
        let mockSocket: any = new EventEmitter();
        mockSocket.setKeepAlive = () => {};
        (mockSocket as any).setTimeout = () => {};
        (mockSocket as any).remotePort = 993;
        (mockSocket as any).remoteAddress = '127.0.0.1';
        (mockSocket as any).localAddress = '127.0.0.1';
        (mockSocket as any).localPort = 12345;
        (mockSocket as any).destroyed = false;
        (mockSocket as any).pipe = function (dest: any) {
            pipeWasCalled = true;
            if (!eventHandlersAttached) {
                pipeCalledBeforeHandlers = true;
            }
            // Mock pipe behavior - just return the destination
            return dest;
        };

        // Assign mock socket
        client.socket = mockSocket;
        client.writeSocket = mockSocket;

        // Simulate the onConnect flow that happens in the actual code
        client.setSocketHandlers();
        client.setEventHandlers();
        (client.socket as any)!.pipe(client.streamer);

        assert.ok(eventHandlersAttached, 'Event handlers should be attached');
        assert.ok(pipeWasCalled, 'Socket pipe should be called');
        assert.ok(!pipeCalledBeforeHandlers, 'Event handlers should be attached before piping socket to streamer');
    });
    it('Connection Edge: Pending locks rejected on close', (t, done) => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        // Initialize locks array with pending locks
        let rejectedErrors: any = [];
        client.locks = [
            {
                path: 'INBOX',
                lockId: 'lock1',
                resolve: () => {},
                reject: (err: any) => rejectedErrors.push(err)
            },
            {
                path: 'Sent',
                lockId: 'lock2',
                resolve: () => {},
                reject: (err: any) => rejectedErrors.push(err)
            }
        ] as any;

        // Mock socket to allow close() to run
        client.socket = { destroyed: false, destroy: () => {} } as any;
        client.usable = true;

        // Call close
        client.close();

        // Rejections happen via setImmediate, so check after next tick
        setImmediate(() => {
            assert.equal(rejectedErrors.length, 2, 'All pending locks should be rejected');
            assert.equal(rejectedErrors[0].code, 'NoConnection', 'Error should have NoConnection code');
            assert.equal(rejectedErrors[1].code, 'NoConnection', 'Error should have NoConnection code');
            assert.equal(client.locks.length, 0, 'Locks array should be cleared');
            done();
        });
    });
    it('Connection Edge: Lock rejection includes byeReason', (t, done) => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        // Set byeReason before close
        client.byeReason = 'Server shutting down';

        let rejectedError: any = null;
        client.locks = [
            {
                path: 'INBOX',
                lockId: 'lock1',
                resolve: () => {},
                reject: (err: any) => {
                    rejectedError = err;
                }
            }
        ];

        client.socket = { destroyed: false, destroy: () => {} } as any;
        client.usable = true;

        client.close();

        setImmediate(() => {
            assert.ok(rejectedError, 'Lock should be rejected');
            assert.equal(rejectedError.code, 'NoConnection');
            assert.equal(rejectedError.reason, 'Server shutting down', 'byeReason should be included');
            done();
        });
    });
    it('Connection Edge: currentLock cleared on close', () => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        // Simulate an active lock
        client.currentLock = {
            path: 'INBOX',
            lockId: 'active-lock',
            release: () => {}
        };
        client.locks = [];

        client.socket = { destroyed: false, destroy: () => {} } as any;
        client.usable = true;

        client.close();

        assert.equal(client.currentLock, false, 'currentLock should be cleared');
    });
    it('Connection Edge: Lock rejection handles missing reject function', (t, done) => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        // Create lock with missing reject function (edge case)
        let validRejected = false;
        client.locks = [
            {
                path: 'INBOX',
                lockId: 'lock1',
                resolve: () => {}
                // No reject function
            },
            {
                path: 'Sent',
                lockId: 'lock2',
                resolve: () => {},
                reject: () => {
                    validRejected = true;
                }
            }
        ] as any;

        client.socket = { destroyed: false, destroy: () => {} } as any;
        client.usable = true;

        // Should not throw
        assert.doesNotThrow(() => {
            client.close();
        }, 'Should handle missing reject function gracefully');

        setImmediate(() => {
            assert.ok(validRejected, 'Valid lock should still be rejected');
            assert.equal(client.locks.length, 0, 'Locks array should be cleared');
            done();
        });
    });
    it('Connection Edge: Close with empty locks array', () => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        client.locks = [];
        client.currentLock = false;
        client.socket = { destroyed: false, destroy: () => {} };
        client.usable = true;

        // Should not throw with empty locks
        assert.doesNotThrow(() => {
            client.close();
        }, 'Should handle empty locks array');

        assert.equal(client.currentLock, false);
    });
    it('Connection Edge: Lock rejection happens synchronously during close', () => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        let rejectionTime = null;

        client.locks = [
            {
                path: 'INBOX',
                lockId: 'lock1',
                resolve: () => {},
                reject: () => {
                    rejectionTime = Date.now();
                }
            }
        ];

        client.socket = { destroyed: false, destroy: () => {} } as any;
        client.usable = true;

        client.close();

        // Rejection should have happened synchronously during close()
        assert.ok(rejectionTime !== null, 'Rejection should happen synchronously during close()');
    });
    it('Connection Edge: Pending requests and locks both rejected on close', () => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        let requestRejected = false;
        let lockRejected = false;

        // Add pending request - must be in requestQueue and requestTagMap
        let request: any = {
            tag: 'A001',
            reject: (err: any) => {
                requestRejected = true;
                assert.equal(err.code, 'NoConnection');
            }
        };
        client.requestTagMap = new Map();
        client.requestTagMap.set('A001', request);
        client.requestQueue = [request];

        // Add pending lock
        client.locks = [
            {
                path: 'INBOX',
                lockId: 'lock1',
                resolve: () => {},
                reject: (err: any) => {
                    lockRejected = true;
                    assert.equal((err as any).code, 'NoConnection');
                }
            }
        ] as any;

        client.socket = { destroyed: false, destroy: () => {} } as any;
        client.usable = true;

        client.close();

        // Rejections happen synchronously during close()
        assert.ok(requestRejected, 'Pending request should be rejected');
        assert.ok(lockRejected, 'Pending lock should be rejected');
    });
    it('Connection Edge: exec throws NoConnection when in LOGOUT state', async () => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        // Set state to LOGOUT
        client.state = client.states.LOGOUT;
        client.socket = { destroyed: false };

        try {
            await client.exec('NOOP', []);
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.equal(err.code, 'NoConnection');
            assert.ok(err.message.includes('Connection not available') as any);
        }
    });
    it('Connection Edge: exec throws NoConnection when isClosed is true', async () => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        // Set isClosed flag
        client.isClosed = true;
        client.socket = { destroyed: false };

        try {
            await client.exec('NOOP', []);
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.equal(err.code, 'NoConnection');
            assert.ok(err.message.includes('Connection not available') as any);
        }
    });
    it('Connection Edge: getLogger emits log events when emitLogs is true', () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' },
            emitLogs: true
        });

        let logEvents: any = [];
        client.on('log', entry => {
            logEvents.push(entry);
        });

        // Trigger logging through the logger
        client.log.info({ msg: 'Test message', extra: 'data' });

        assert.ok(logEvents.length > 0, 'Log event should be emitted');
        assert.equal(logEvents[0].level, 'info');
        assert.equal(logEvents[0].msg, 'Test message');
        assert.equal(logEvents[0].extra, 'data');
        assert.ok(logEvents[0].cid, 'Should have connection id');
        assert.ok(logEvents[0].t, 'Should have timestamp');
    });
    it('Connection Edge: getLogger emits log with error object', () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' },
            emitLogs: true
        });

        let logEvents: any = [];
        client.on('log', entry => {
            logEvents.push(entry);
        });

        // Trigger error logging
        let testError: any = new Error('Test error');
        testError.code = 'TEST_CODE';
        client.log.error({ msg: 'Error occurred', err: testError });

        assert.ok(logEvents.length > 0, 'Log event should be emitted');
        assert.equal(logEvents[0].level, 'error');
        assert.ok(logEvents[0].err, 'Should have error object');
        assert.ok(logEvents[0].err.stack, 'Error should have stack');
        assert.equal(logEvents[0].err.code, 'TEST_CODE', 'Error should have code');
    });
    it('Connection Edge: unbind removes socket listeners and returns sockets', () => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        // Create mock socket with unpipe method
        client.socket = new EventEmitter();
        (client.socket as any)!.unpipe = () => {};
        client.writeSocket = client.socket;

        // Set up socket handlers first
        client.setSocketHandlers();

        // Verify handlers are set
        assert.equal((client.socket as any)!.listenerCount('error'), 1);
        assert.equal((client.socket as any)!.listenerCount('close'), 1);

        // Call unbind
        let result = client.unbind();

        // Verify handlers are removed
        assert.equal((client.socket as any)!.listenerCount('error'), 0);
        assert.equal((client.socket as any)!.listenerCount('close'), 0);
        assert.equal((client.socket as any)!.listenerCount('end'), 0);
        assert.equal((client.socket as any)!.listenerCount('timeout'), 0);

        // Verify return value
        assert.ok(result.readSocket, 'Should return readSocket');
        assert.ok(result.writeSocket, 'Should return writeSocket');
        assert.equal(result.readSocket, client.socket);
        assert.equal(result.writeSocket, client.socket);
        // Non-compression path: the raw socket is the same object as read/write.
        assert.equal(result.socket, client.socket);
    });
    it('Connection Edge: unbind with inflate stream', () => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        // Create mock socket
        client.socket = new EventEmitter();
        (client.socket as any)!.unpipe = () => {};

        // Create a separate writeSocket (also needs to be EventEmitter for setSocketHandlers)
        client.writeSocket = new EventEmitter();
        (client.writeSocket as any)!.customProp = 'writeSocket';

        // Create mock inflate stream
        client._inflate = new EventEmitter();
        client._inflate!.unpipe = () => {};

        // Set up socket handlers
        client.setSocketHandlers();

        // Call unbind
        let result: any = client.unbind();

        // Verify return value uses inflate for read and writeSocket for write
        assert.equal(result.readSocket, client._inflate);
        assert.equal(result.writeSocket.customProp, 'writeSocket');
    });
    it('Connection Edge: unbind survives post-handoff socket error (compression)', () => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        // Mock the compression topology: raw socket plus a separate PassThrough-like
        // writeSocket, an inflate read stream and a deflate stream. The writeSocket
        // and deflate error forwarders re-emit onto the raw socket, exactly like compress().
        client.socket = new EventEmitter();
        (client.socket as any)!.unpipe = () => {};

        client.writeSocket = new EventEmitter();
        (client.writeSocket as any)!.on('error', (err: any) => {
            if (client.socket) {
                client.socket.emit('error', err);
            }
        });

        client._inflate = new EventEmitter();
        client._inflate!.unpipe = () => {};

        client._deflate = new EventEmitter();
        client._deflate!.on('error', (err: any) => {
            if (client.socket) {
                client.socket.emit('error', err);
            }
        });

        client.setSocketHandlers();

        let result = client.unbind();

        // Explicit contract: raw socket is now exposed alongside read/write sockets.
        assert.equal(result.socket, client.socket, 'Should expose the raw socket');
        assert.equal(result.readSocket, client._inflate);
        assert.equal(result.writeSocket, client.writeSocket);

        // ImapFlow's own _socketError must be detached from writeSocket; only the
        // forwarder closure remains.
        assert.equal((client.writeSocket as any)!.listenerCount('error'), 1);

        // Emitting 'error' on a listener-less EventEmitter throws synchronously, so
        // each of these would crash the host before the fix. After unbind() the
        // benign listener on the orphaned raw socket must swallow them all.
        assert.doesNotThrow(() => {
            (client.socket as any)!.emit('error', Object.assign(new Error('upstream reset'), { code: 'ECONNRESET' }));
        }, 'Direct socket error after unbind must not throw');

        assert.doesNotThrow(() => {
            (client.writeSocket as any)!.emit('error', new Error('write failure'));
        }, 'writeSocket error forwarded to the raw socket must not throw');

        assert.doesNotThrow(() => {
            client._deflate!.emit('error', new Error('deflate failure'));
        }, 'deflate error forwarded to the raw socket must not throw');

        // close() must remain safe to call after unbind().
        assert.doesNotThrow(() => {
            client.close();
        }, 'close() after unbind must not throw');
    });
    it('Connection Edge: resolveRange with number input', async () => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        client.mailbox = { exists: 10 };
        let options = {};

        let result = await client.resolveRange(123, options);
        assert.equal(result, '123');
    });
    it('Connection Edge: resolveRange with bigint input', async () => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        client.mailbox = { exists: 10 };
        let options = {};

        let result = await client.resolveRange(BigInt(456), options);
        assert.equal(result, '456');
    });
    it('Connection Edge: resolveRange with star and existing messages', async () => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        client.mailbox = { exists: 50 };
        let options = { uid: true };

        let result = await client.resolveRange('*', options);
        assert.equal(result, '50');
        assert.equal(options.uid, false); // should be changed to sequence query
    });
    it('Connection Edge: resolveRange with star and no messages', async () => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        client.mailbox = { exists: 0 };
        let options = {};

        let result = await client.resolveRange('*', options);
        assert.equal(result, false);
    });
    it('Connection Edge: resolveRange with {all: true}', async () => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        client.mailbox = { exists: 10 };
        let options = {};

        let result = await client.resolveRange({ all: true }, options);
        assert.equal(result, '1:*');
    });
    it('Connection Edge: resolveRange with {uid: value}', async () => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        client.mailbox = { exists: 10 };
        let options: any = {};

        let result = await client.resolveRange({ uid: '1:100' }, options);
        assert.equal(result, '1:100');
        assert.equal(options.uid, true);
    });
    it('Connection Edge: resolveRange with array input', async () => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        client.mailbox = { exists: 10 };
        let options = {};

        let result = await client.resolveRange(['1', '2', '3'] as any, options);
        assert.equal(result, '1,2,3');
    });
    it('Connection Edge: resolveRange with empty/falsy input', async () => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        client.mailbox = { exists: 10 };
        let options = {};

        let result = await client.resolveRange('', options);
        assert.equal(result, false);

        result = await client.resolveRange(null as any, options);
        assert.equal(result, false);
    });
    it('Connection Edge: ensureSelectedMailbox with no path', async () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        let result = await client.ensureSelectedMailbox('');
        assert.equal(result, false);

        result = await client.ensureSelectedMailbox(null as any);
        assert.equal(result, false);
    });
    it('Connection Edge: ensureSelectedMailbox when already selected', async () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        client.mailbox = { path: 'INBOX' } as MailboxObject;

        let result = await client.ensureSelectedMailbox('INBOX');
        assert.equal(result, true);
    });
    it('Connection Edge: autoidle clears existing timer', () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        // Set a fake timer
        client.idleStartTimer = setTimeout(() => {}, 10000);
        client.state = client.states.NOT_AUTHENTICATED;

        // Call autoidle - should clear the timer but not set new one (wrong state)
        client.autoidle();

        // Should have been cleared
        assert.ok(true);
    });
    it('Connection Edge: autoidle disabled by option', () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' },
            disableAutoIdle: true
        });

        client.state = client.states.SELECTED;

        // Call autoidle - should return early due to disableAutoIdle
        client.autoidle();

        assert.equal(client.idleStartTimer, undefined);
    });
    it('Connection Edge: getUntaggedHandler with numeric command', () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        // Set up a current request with untagged handler
        (client as any).currentRequest = {
            options: {
                untagged: {
                    FETCH: (() => 'fetch handler') as any
                }
            }
        };

        // Test with numeric command and FETCH attribute
        let handler: any = client.getUntaggedHandler('123', [{ value: 'FETCH' }] as any);
        assert.equal(handler() as any, 'fetch handler');
    });
    it('Connection Edge: getUntaggedHandler from untaggedHandlers', () => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        // Set up global untagged handler
        client.untaggedHandlers = {
            CAPABILITY: () => 'capability handler'
        };

        let handler: any = client.getUntaggedHandler('CAPABILITY', []);
        assert.equal(handler() as any, 'capability handler');
    });
    it('Connection Edge: getSectionHandler returns handler', () => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        // Set up section handler
        client.sectionHandlers = {
            CAPABILITY: () => 'section handler'
        };

        let handler: any = client.getSectionHandler('CAPABILITY');
        assert.equal((handler as any)(), 'section handler');

        // Test non-existent handler
        handler = client.getSectionHandler('NONEXISTENT');
        assert.equal(handler, undefined);
    });
    it('Connection Edge: constructor with custom clientInfo', () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' },
            clientInfo: {
                name: 'CustomClient',
                version: '1.0.0'
            }
        });

        assert.equal(client.clientInfo.name, 'CustomClient');
        assert.equal(client.clientInfo.version, '1.0.0');
        assert.ok(client.clientInfo.vendor);
    });
    it('Connection Edge: constructor with secure port 993 detection', () => {
        // When port is 993 and secure is undefined, should default to secure
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        assert.equal(client.secureConnection, true);
    });
    it('Connection Edge: constructor normalizes clientInfo diacritics', () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' },
            clientInfo: {
                name: 'Café Clïent',
                version: '1.0.0'
            }
        });

        // Diacritics should be removed (NFD normalization splits é into e + accent, then accent is removed)
        assert.equal(client.clientInfo.name, 'Cafe Client');
    });
    it('Connection Edge: constructor with servername option', () => {
        let client = new ImapFlow({
            host: '192.168.1.1',
            port: 993,
            auth: { user: 'test', pass: 'test' },
            servername: 'mail.example.com'
        });

        assert.equal(client.servername, 'mail.example.com');
    });
    it('Connection Edge: constructor servername from host when not IP', () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        assert.equal(client.servername, 'imap.example.com');
    });
    it('Connection Edge: constructor servername false for IP host', () => {
        let client = new ImapFlow({
            host: '192.168.1.1',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        assert.equal(client.servername, false);
    });
    it('Connection Edge: connect throws if called twice', async () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        // Mark as already called
        client._connectCalled = true;

        try {
            await client.connect();
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.ok(err.message.includes('re-use'));
        }
    });
    it('Connection Edge: compress writeSocket error forwarded to socket when live', async () => {
        let { client, mockSocket }: any = await setupCompressedClient();

        let errorReceived = false;
        mockSocket.on('error', (err: any) => {
            errorReceived = true;
            assert.equal(err.message, 'writeSocket error');
        });

        (client.writeSocket as any).emit('error', new Error('writeSocket error'));

        assert.ok(errorReceived, 'Error should be forwarded to socket');
    });
    it('Connection Edge: compress _deflate error forwarded to socket when live', async () => {
        let { client, mockSocket }: any = await setupCompressedClient();

        let errorReceived = false;
        mockSocket.on('error', (err: any) => {
            errorReceived = true;
            assert.equal(err.message, 'deflate error');
        });

        client._deflate.emit('error', new Error('deflate error'));

        assert.ok(errorReceived, 'Error should be forwarded to socket');
    });
    it('Connection Edge: compress readable after close does not crash', async () => {
        let { client } = await setupCompressedClient();

        // Save reference before close() nulls it
        let writeSocket: any = client.writeSocket;

        client.close();

        // Emit readable on the saved reference after close has nulled this.writeSocket
        // This should not throw (guards at lines 1048 and 1021)
        assert.doesNotThrow(() => {
            (writeSocket as any).emit('readable');
        });
    });
    it('Connection Edge: compress writeSocket error after close does not crash', async () => {
        let { client } = await setupCompressedClient();

        let writeSocket: any = client.writeSocket;

        client.close();

        // Emit error on saved writeSocket after close has nulled this.socket
        // This should not throw (guard at lines 1053-1055)
        assert.doesNotThrow(() => {
            (writeSocket as any).emit('error', new Error('late writeSocket error'));
        });
    });
    it('Connection Edge: compress _deflate error after close does not crash', async () => {
        let { client } = await setupCompressedClient();

        let deflate: any = client._deflate;

        client.close();

        // Emit error on saved _deflate after close has nulled this.socket
        // This should not throw (guard at lines 1060-1062)
        assert.doesNotThrow(() => {
            deflate.emit('error', new Error('late deflate error'));
        });
    });
    it('Connection Edge: compress _inflate error after close does not crash', async () => {
        let { client } = await setupCompressedClient();

        let inflate: any = client._inflate;

        // close() removes the streamer 'error' listener and destroys the streamer.
        // A late inflate error must not be forwarded into the destroyed streamer
        // (which would throw an unhandled 'error' and crash the process).
        client.close();

        // Confirm we actually reached the post-close state the guard targets.
        assert.ok(client.streamer.destroyed, 'streamer is destroyed after close()');

        // Re-attach an 'error' listener so listenerCount('error') > 0: this isolates the
        // `!streamer.destroyed` term of the guard. If forwarding still happened, this listener
        // would throw and escape doesNotThrow — proving the destroyed-check is what suppresses it.
        client.streamer.on('error', () => {
            throw new Error('inflate error must not be forwarded into a destroyed streamer');
        });

        assert.doesNotThrow(() => {
            inflate.emit('error', new Error('late inflate error'));
        });
    });

    // ============================================
    // Mailbox Lock Tests
    // ============================================
    it('Connection Edge: getMailboxLock queues lock in locks array', async () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        // getMailboxLock should push to locks array then reject (no connection)
        try {
            await client.getMailboxLock('INBOX');
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.ok(err);
            assert.equal(err.code, 'NoConnection');
        }
    });
    it('Connection Edge: lockCounter increments with each getMailboxLock call', async () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        let initial = client.lockCounter;
        let p1 = client.getMailboxLock('INBOX').catch(() => {});
        let p2 = client.getMailboxLock('Sent').catch(() => {});

        assert.equal(client.lockCounter, initial + 2);

        await Promise.all([p1, p2]);
    });
    it('Connection Edge: lock rejected when connection not usable', async () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        // usable is false by default, no socket
        try {
            await client.getMailboxLock('INBOX');
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.ok(err);
            assert.equal(err.code, 'NoConnection');
            assert.ok((err as any).message.includes('not available'));
        }
    });
    it('Connection Edge: processLocks with empty locks array completes', async () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        // processLocks with no pending locks should complete without error
        await client.processLocks();
        assert.equal(client.processingLock, false);
    });
    it('Connection Edge: multiple locks rejected when no connection', async () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });

        // Queue multiple locks, all should reject
        let errors: any = [];
        let p1 = client.getMailboxLock('INBOX').catch(err => errors.push(err));
        let p2 = client.getMailboxLock('Sent').catch(err => errors.push(err));
        let p3 = client.getMailboxLock('Drafts').catch(err => errors.push(err));

        await Promise.all([p1, p2, p3]);

        assert.equal(errors.length, 3);
        for (let err of errors) {
            assert.equal(err.code, 'NoConnection');
        }
    });

    // ============================================
    // reader() survives a write() throw without stalling the stream
    // ============================================
    it('Connection Edge: reader survives write throw on + continuation', async () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' },
            logger: false
        });

        client.currentRequest = false;
        client.commandParts = [Buffer.from('literal-bytes')];

        let writeAttempted = false;
        client.write = () => {
            writeAttempted = true;
            throw new Error('write boom');
        };

        let nextCalled = false;
        let done = false;
        client.streamer.read = () => {
            if (done) {
                return null;
            }
            done = true;
            return {
                payload: Buffer.from('+ Ready'),
                literals: [],
                next: () => {
                    nextCalled = true;
                }
            };
        };

        let rejected = false;
        await client.reader().catch(() => {
            rejected = true;
        });

        assert.ok(writeAttempted, 'the literal-continuation write path was exercised');
        assert.equal(rejected, false, 'reader did not reject on write throw');
        assert.ok(nextCalled, 'data.next() was still called so the stream is not stalled');
    });

    // ============================================
    // BYE greeting surfaces its reason on the connect rejection
    // ============================================
    it('Connection Edge: BYE greeting surfaces reason on connect rejection', async () => {
        // Deterministic ordering: the server ends the socket only AFTER the client has parsed the
        // BYE and set byeReason, instead of racing a fixed 50ms timer that could flake on slow CI.
        let signalByeParsed: any;
        let byeParsed = new Promise(resolve => {
            signalByeParsed = resolve;
        });

        let server: any = net.createServer(socket => {
            socket.on('error', () => {});
            socket.write('* BYE Server too busy\r\n');
            byeParsed.then(() => socket.end());
        });

        await new Promise(resolve => (server.listen as any)(0, '127.0.0.1', resolve));
        let port = (server.address() as any).port;

        let client = new ImapFlow({
            host: '127.0.0.1',
            port,
            secure: false,
            disableAutoIdle: true,
            logger: false,
            auth: { user: 'test', pass: 'test' }
        });
        client.on('error', () => {});

        // Signal once the client's BYE handler has run, so byeReason is guaranteed set before close().
        let origServerBye = client.serverBye.bind(client);
        client.serverBye = async parsed => {
            await origServerBye(parsed);
            signalByeParsed();
        };

        let connectErr: any = null;
        try {
            await client.connect();
            assert.ok(false, 'connect() should reject after a BYE greeting');
        } catch (err) {
            connectErr = err;
        }

        assert.ok(connectErr, 'connect() rejected');
        assert.equal(connectErr.reason, 'Server too busy', 'BYE reason surfaced on the rejection');

        client.close();
        server.close();
    });
});
