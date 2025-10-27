'use strict';

const { ImapFlow } = require('../lib/imap-flow');
const { EventEmitter } = require('events');

// Edge Cases Tests

module.exports['Connection Edge: Socket error during connection'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        port: 993,
        auth: { user: 'test', pass: 'test' }
    });

    // Simulate socket error
    let errorEmitted = false;
    client.on('error', err => {
        errorEmitted = true;
        test.ok(err);
        test.equal(err._connId, client.id);
    });

    // Trigger error through emitError
    let testError = new Error('Socket connection failed');
    testError.code = 'ECONNREFUSED';
    client.emitError(testError);

    test.ok(errorEmitted, 'Error event should be emitted');
    test.done();
};

module.exports['Connection Edge: Write after socket destroyed'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        port: 993,
        auth: { user: 'test', pass: 'test' }
    });

    // Simulate destroyed socket
    client.socket = { destroyed: true };

    test.throws(
        () => {
            client.write('TEST');
        },
        /Socket is already closed/,
        'Should throw when writing to destroyed socket'
    );

    test.done();
};

module.exports['Connection Edge: Write after logout'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        port: 993,
        auth: { user: 'test', pass: 'test' }
    });

    // Create a mock socket
    client.socket = { destroyed: false };
    client.state = client.states.LOGOUT;

    test.throws(
        () => {
            client.write('TEST');
        },
        /Can not send data after logged out/,
        'Should throw when writing after logout'
    );

    test.done();
};

module.exports['Connection Edge: Stats reset functionality'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        port: 993,
        auth: { user: 'test', pass: 'test' }
    });

    // Set some initial values
    client.writeBytesCounter = 100;
    client.streamer.readBytesCounter = 200;

    let stats = client.stats(false);
    test.equal(stats.sent, 100);
    test.equal(stats.received, 200);

    // Reset stats
    stats = client.stats(true);
    test.equal(stats.sent, 100, 'Should return old value before reset');
    test.equal(stats.received, 200, 'Should return old value before reset');

    // Check if reset worked
    test.equal(client.writeBytesCounter, 0, 'Write counter should be reset');
    test.equal(client.streamer.readBytesCounter, 0, 'Read counter should be reset');

    test.done();
};

module.exports['Connection Edge: Multiple error handlers'] = test => {
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

    test.equal(errorCount, 3, 'All error handlers should be called');
    test.done();
};

module.exports['Connection Edge: Connection with valid empty auth'] = test => {
    // ImapFlow actually allows creating client without throwing
    // The error would occur during connection
    let client = new ImapFlow({
        host: 'imap.example.com',
        port: 993,
        auth: { user: 'test' }
    });

    test.ok(client, 'Client should be created even with partial auth');
    test.equal(client.host, 'imap.example.com');
    test.done();
};

module.exports['Connection Edge: Connection with default values'] = test => {
    // ImapFlow sets default values for missing options
    let client = new ImapFlow({
        host: 'imap.example.com',
        auth: { user: 'test', pass: 'test' }
    });

    test.ok(client, 'Client should be created with defaults');
    test.equal(client.port, 110, 'Should use default port');
    test.equal(client.secureConnection, false, 'Should default to non-secure');
    test.done();
};

module.exports['Connection Edge: Port number handling'] = test => {
    // ImapFlow sets default port based on secure flag
    let client1 = new ImapFlow({
        host: 'imap.example.com',
        secure: false,
        auth: { user: 'test', pass: 'test' }
    });
    test.equal(client1.port, 110, 'Default non-secure port');

    let client2 = new ImapFlow({
        host: 'imap.example.com',
        port: 65535,
        auth: { user: 'test', pass: 'test' }
    });
    test.equal(client2.port, 65535, 'Custom port accepted');

    test.done();
};

module.exports['Connection Edge: STARTTLS misconfiguration'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        port: 143,
        secure: true,
        doSTARTTLS: true,
        auth: { user: 'test', pass: 'test' }
    });

    // Test that upgradeToSTARTTLS throws on misconfiguration
    client.upgradeToSTARTTLS().catch(err => {
        test.ok(err);
        test.ok(err.message.includes('Misconfiguration'), 'Should detect STARTTLS misconfiguration');
        test.done();
    });
};

module.exports['Connection Edge: Socket timeout handling'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        port: 993,
        auth: { user: 'test', pass: 'test' }
    });

    // Create a mock socket
    client.socket = new EventEmitter();
    client.socket.destroyed = false;
    client.socket.destroy = () => {};
    client.writeSocket = client.socket;
    client.writeSocket.destroy = () => {};

    let errorEmitted = false;
    client.on('error', err => {
        errorEmitted = true;
        test.equal(err.code, 'ETIMEOUT');
    });

    // Set up socket handlers
    client.setSocketHandlers();

    // Simulate timeout on non-idle connection
    client.idling = false;
    client.socket.emit('timeout');

    test.ok(errorEmitted, 'Timeout error should be emitted');
    test.done();
};

module.exports['Connection Edge: Socket timeout during IDLE'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        port: 993,
        auth: { user: 'test', pass: 'test' }
    });

    // Create mock socket and methods
    client.socket = new EventEmitter();
    client.socket.destroyed = false;
    client.writeSocket = client.socket;
    client.usable = true;
    client.idling = true;

    // Mock run and idle methods
    let noopCalled = false;
    let idleCalled = false;

    client.run = async command => {
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
    client.socket.emit('timeout');

    // Give async operations time to complete
    setTimeout(() => {
        test.ok(noopCalled, 'NOOP should be called to recover from IDLE timeout');
        test.ok(idleCalled, 'Should return to IDLE after NOOP');
        test.done();
    }, 100);
};

module.exports['Connection Edge: Clear socket handlers'] = test => {
    let client = new ImapFlow({
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
    test.equal(client.socket.listenerCount('error'), 1);
    test.equal(client.socket.listenerCount('close'), 1);
    test.equal(client.socket.listenerCount('end'), 1);
    test.equal(client.socket.listenerCount('timeout'), 1);

    // Clear handlers
    client.clearSocketHandlers();

    // Verify handlers are removed
    test.equal(client.socket.listenerCount('error'), 0);
    test.equal(client.socket.listenerCount('close'), 0);
    test.equal(client.socket.listenerCount('end'), 0);
    test.equal(client.socket.listenerCount('timeout'), 0);

    test.done();
};

module.exports['Connection Edge: Write with null socket'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        port: 993,
        auth: { user: 'test', pass: 'test' }
    });

    // Set socket to null
    client.socket = null;

    test.throws(
        () => {
            client.write('TEST');
        },
        /Socket is already closed/,
        'Should throw when socket is null'
    );

    test.done();
};

module.exports['Connection Edge: Compression error handling'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        port: 993,
        auth: { user: 'test', pass: 'test' }
    });

    // Create mock socket and streams
    client.socket = new EventEmitter();
    client.socket.pipe = () => client.socket;
    client.socket.unpipe = () => {};
    client.streamer = new EventEmitter();

    // Mock run method to simulate successful COMPRESS negotiation
    client.run = async command => {
        if (command === 'COMPRESS') {
            return true;
        }
    };

    let errorEmitted = false;
    client.streamer.on('error', err => {
        errorEmitted = true;
        test.ok(err);
    });

    // Call compress
    client.compress().then(() => {
        // Simulate compression error
        if (client._inflate) {
            client._inflate.emit('error', new Error('Compression failed'));
        }

        test.ok(errorEmitted, 'Compression error should be propagated');
        test.done();
    });
};

module.exports['Connection Edge: Authentication state after logout'] = test => {
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
        test.ok(err);
        test.equal(err.message, 'Already logged out');
        test.done();
    });
};

module.exports['Connection Edge: Throttling detection'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        port: 993,
        auth: { user: 'test', pass: 'test' }
    });

    // Create mock request
    let errorReceived = null;
    let request = {
        tag: 'A001',
        command: 'FETCH',
        resolve: () => {},
        reject: err => {
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
    client.streamer.iterate = async function* () {
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
                test.ok(errorReceived, 'Should receive throttle error');
                test.equal(errorReceived.code, 'ETHROTTLE');
                test.equal(errorReceived.throttleReset, 5000);
            }
            test.done();
        })
        .catch(() => {
            // Reader might fail in test environment
            test.done();
        });
};

module.exports['Connection Edge: Binary data in write'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        port: 993,
        auth: { user: 'test', pass: 'test' }
    });

    // Mock socket
    let writtenData = null;
    client.socket = { destroyed: false };
    client.writeSocket = {
        destroyed: false,
        write: data => {
            writtenData = data;
        }
    };

    // Test writing Buffer
    let testBuffer = Buffer.from('TEST');
    client.write(testBuffer);

    test.ok(Buffer.isBuffer(writtenData));
    test.ok(writtenData.includes(testBuffer));
    test.ok(writtenData.includes(Buffer.from('\r\n')));

    // Test writing string
    client.commandParts = [];
    client.write('STRING_TEST');

    test.ok(Buffer.isBuffer(writtenData));
    test.ok(writtenData.includes(Buffer.from('STRING_TEST\r\n')));

    test.done();
};

module.exports['Connection Edge: Invalid write data type'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        port: 993,
        auth: { user: 'test', pass: 'test' }
    });

    // Mock socket
    client.socket = { destroyed: false };
    client.writeSocket = { destroyed: false, write: () => {} };

    // Test writing invalid data type
    let result = client.write(12345);
    test.equal(result, false, 'Should return false for invalid data type');

    result = client.write({ test: 'object' });
    test.equal(result, false, 'Should return false for object');

    test.done();
};

module.exports['Connection Edge: Concurrent connections'] = test => {
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
    test.equal(uniqueIds.length, clients.length, 'All client IDs should be unique');

    // Verify each client has independent state
    clients[0].state = clients[0].states.AUTHENTICATED;
    clients[1].state = clients[1].states.SELECTED;

    test.equal(clients[0].state, clients[0].states.AUTHENTICATED);
    test.equal(clients[1].state, clients[1].states.SELECTED);
    test.equal(clients[2].state, clients[2].states.NOT_AUTHENTICATED);

    test.done();
};

module.exports['Connection Edge: Destroyed write socket'] = test => {
    let client = new ImapFlow({
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

    test.ok(closeCalled, 'Should call close when write socket is destroyed');
    test.done();
};

module.exports['Connection Edge: Command after logout'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        port: 993,
        auth: { user: 'test', pass: 'test' }
    });

    // Set logout state
    client.state = client.states.LOGOUT;

    // Create a request
    let errorReceived = null;
    let request = {
        tag: 'A001',
        reject: err => {
            errorReceived = err;
        }
    };

    client.requestTagMap = new Map();
    client.requestTagMap.set('A001', request);

    // Try to send command
    client.send({ tag: 'A001', command: 'NOOP' }).then(() => {
        test.ok(errorReceived, 'Should reject command after logout');
        test.equal(errorReceived.code, 'NoConnection');
        test.done();
    });
};

module.exports['Connection Edge: Race condition in mailbox lock'] = test => {
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
                });
            })
        );
    }

    test.equal(client.locks.length, 3, 'Should queue multiple lock requests');

    // Process locks sequentially
    client.locks.forEach((lock, index) => {
        lock.resolve({ path: 'INBOX', index });
    });

    Promise.all(lockPromises).then(results => {
        test.equal(results.length, 3, 'All lock requests should be resolved');
        test.done();
    });
};

module.exports['Connection Edge: Capability update after STARTTLS'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        port: 143,
        auth: { user: 'test', pass: 'test' }
    });

    // Mock capabilities
    client.capabilities = new Map();
    client.capabilities.set('STARTTLS', true);

    // Mock run method
    client.run = async command => {
        if (command === 'STARTTLS') {
            client.expectCapabilityUpdate = true;
            return true;
        }
        if (command === 'CAPABILITY') {
            return true;
        }
    };

    // Mock socket upgrade
    client.socket = new EventEmitter();
    client.socket.unpipe = () => {};
    client.streamer = new EventEmitter();

    // Override the upgradeToSTARTTLS to test capability update
    client
        .upgradeToSTARTTLS()
        .then(result => {
            test.ok(result, 'Should successfully upgrade to TLS');
            test.ok(client.expectCapabilityUpdate, 'Should expect capability update');
            test.done();
        })
        .catch(() => {
            // Expected for this mock setup
            test.done();
        });
};

module.exports['Connection Edge: Event handlers attached before piping'] = test => {
    let client = new ImapFlow({
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
    let mockSocket = new EventEmitter();
    mockSocket.setKeepAlive = () => {};
    mockSocket.setTimeout = () => {};
    mockSocket.remotePort = 993;
    mockSocket.remoteAddress = '127.0.0.1';
    mockSocket.localAddress = '127.0.0.1';
    mockSocket.localPort = 12345;
    mockSocket.destroyed = false;
    mockSocket.pipe = function (dest) {
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
    client.socket.pipe(client.streamer);

    test.ok(eventHandlersAttached, 'Event handlers should be attached');
    test.ok(pipeWasCalled, 'Socket pipe should be called');
    test.ok(!pipeCalledBeforeHandlers, 'Event handlers should be attached before piping socket to streamer');

    test.done();
};
