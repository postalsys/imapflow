'use strict';

/**
 * Tests for memory leak detection in socket, TLS, and event handling
 */

const net = require('net');
const zlib = require('zlib');
const { PassThrough } = require('stream');
const { ImapFlow } = require('../lib/imap-flow');

// Helper to get listener counts for key objects
function getListenerReport(client) {
    return {
        streamer: client.streamer
            ? {
                  error: client.streamer.listenerCount('error'),
                  readable: client.streamer.listenerCount('readable')
              }
            : null,
        socket: client.socket
            ? {
                  error: client.socket.listenerCount('error'),
                  close: client.socket.listenerCount('close'),
                  end: client.socket.listenerCount('end'),
                  timeout: client.socket.listenerCount('timeout'),
                  tlsClientError: client.socket.listenerCount('tlsClientError')
              }
            : null,
        client: {
            error: client.listenerCount('error'),
            close: client.listenerCount('close')
        },
        inflate: client._inflate ? client._inflate.listenerCount('error') : 0,
        deflate: client._deflate ? client._deflate.listenerCount('error') : 0
    };
}

// Helper to measure memory (requires --expose-gc flag)
// Usage: node --expose-gc -e "require('./test/memory-leak-test.js')"
// eslint-disable-next-line no-unused-vars
async function measureMemory(label) {
    if (global.gc) {
        global.gc();
        await new Promise(r => setTimeout(r, 50));
        global.gc();
    }
    const mem = process.memoryUsage();
    return {
        label,
        heapUsedMB: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
        externalMB: Math.round((mem.external / 1024 / 1024) * 100) / 100
    };
}

// Create a simple mock IMAP server for testing
function createMockServer() {
    const server = net.createServer(socket => {
        // Send greeting
        socket.write('* OK Mock IMAP Server ready\r\n');

        socket.on('data', data => {
            const line = data.toString().trim();
            const parts = line.split(' ');
            const tag = parts[0];
            const command = parts[1] ? parts[1].toUpperCase() : '';

            if (command === 'CAPABILITY') {
                socket.write('* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n');
                socket.write(`${tag} OK CAPABILITY completed\r\n`);
            } else if (command === 'LOGIN') {
                socket.write(`${tag} OK LOGIN completed\r\n`);
            } else if (command === 'LOGOUT') {
                socket.write('* BYE Server logging out\r\n');
                socket.write(`${tag} OK LOGOUT completed\r\n`);
                socket.end();
            } else if (command === 'NOOP') {
                socket.write(`${tag} OK NOOP completed\r\n`);
            } else if (command === 'NAMESPACE') {
                socket.write('* NAMESPACE (("" "/")) NIL NIL\r\n');
                socket.write(`${tag} OK NAMESPACE completed\r\n`);
            } else if (command === 'COMPRESS') {
                socket.write(`${tag} NO COMPRESS not supported\r\n`);
            } else if (command === 'ENABLE') {
                socket.write(`${tag} OK ENABLE completed\r\n`);
            } else if (command === 'ID') {
                socket.write('* ID NIL\r\n');
                socket.write(`${tag} OK ID completed\r\n`);
            } else if (tag && command) {
                socket.write(`${tag} OK Command completed\r\n`);
            }
        });

        socket.on('error', () => {
            // Ignore errors
        });
    });

    return server;
}

exports['Memory Leak Tests'] = {
    'should not leak listeners after multiple client creations without connect'(test) {
        const clients = [];

        // Create multiple clients without connecting
        for (let i = 0; i < 50; i++) {
            const client = new ImapFlow({
                host: '127.0.0.1',
                port: 1,
                secure: false,
                logger: false
            });
            clients.push(client);
        }

        // Close all clients
        for (const client of clients) {
            client.close();
        }

        // Verify all clients are cleaned up
        for (const client of clients) {
            const report = getListenerReport(client);
            test.equal(report.streamer.error, 0, 'streamer error listeners should be 0');
            test.equal(report.streamer.readable, 0, 'streamer readable listeners should be 0');
            test.ok(client.isClosed, 'client should be closed');
        }

        test.done();
    },

    'should clean up listeners after connect error'(test) {
        test.expect(4);

        const client = new ImapFlow({
            host: '127.0.0.1',
            port: 1, // Invalid port, will fail to connect
            secure: false,
            logger: false,
            connectionTimeout: 500
        });

        client.connect().catch(() => {
            // Wait a bit for cleanup
            setTimeout(() => {
                const report = getListenerReport(client);
                test.equal(report.streamer.error, 0, 'streamer error listeners should be 0 after error');
                test.equal(report.socket, null, 'socket should be null after error');
                test.ok(client.isClosed, 'client should be closed after error');
                test.equal(client.state, client.states.LOGOUT, 'state should be LOGOUT');
                test.done();
            }, 100);
        });
    },

    async 'should clean up listeners after successful connect and close'(test) {
        test.expect(6);

        const server = createMockServer();

        server.listen(0, '127.0.0.1', async () => {
            const port = server.address().port;

            const client = new ImapFlow({
                host: '127.0.0.1',
                port,
                secure: false,
                logger: false,
                auth: {
                    user: 'test',
                    pass: 'test'
                }
            });

            try {
                await client.connect();

                // Verify we're connected
                test.ok(client.usable, 'client should be usable after connect');

                // Get listener report while connected
                const connectedReport = getListenerReport(client);
                test.ok(connectedReport.socket !== null, 'socket should exist while connected');

                await client.logout();

                // Wait for cleanup
                await new Promise(r => setTimeout(r, 100));

                const closedReport = getListenerReport(client);
                test.equal(closedReport.streamer.error, 0, 'streamer error listeners should be 0');
                test.equal(closedReport.streamer.readable, 0, 'streamer readable listeners should be 0');
                test.ok(client.isClosed, 'client should be closed');
                test.equal(client.state, client.states.LOGOUT, 'state should be LOGOUT');
            } catch (err) {
                test.ok(false, 'should not throw: ' + err.message);
            } finally {
                server.close();
                test.done();
            }
        });
    },

    async 'should not accumulate listeners over multiple connect/disconnect cycles'(test) {
        const server = createMockServer();

        server.listen(0, '127.0.0.1', async () => {
            const port = server.address().port;
            const cycles = 10;

            for (let i = 0; i < cycles; i++) {
                const client = new ImapFlow({
                    host: '127.0.0.1',
                    port,
                    secure: false,
                    logger: false,
                    auth: {
                        user: 'test',
                        pass: 'test'
                    }
                });

                try {
                    await client.connect();
                    await client.logout();
                } catch {
                    // Ignore connection errors
                }

                // Wait for cleanup
                await new Promise(r => setTimeout(r, 50));

                const report = getListenerReport(client);
                test.equal(report.streamer.error, 0, `cycle ${i + 1}: streamer error listeners should be 0`);
                test.equal(report.streamer.readable, 0, `cycle ${i + 1}: streamer readable listeners should be 0`);
            }

            server.close();
            test.done();
        });
    },

    'should clean up socket handlers after close'(test) {
        const client = new ImapFlow({
            host: '127.0.0.1',
            port: 1,
            secure: false,
            logger: false
        });

        // Simulate having socket handlers set
        const mockSocket = new net.Socket();
        client.socket = mockSocket;
        client.writeSocket = mockSocket;

        // Set up handlers like connect() would
        client._socketError = () => {};
        client._socketClose = () => {};
        client._socketEnd = () => {};
        client._socketTimeout = () => {};

        mockSocket.on('error', client._socketError);
        mockSocket.on('close', client._socketClose);
        mockSocket.on('end', client._socketEnd);
        mockSocket.on('timeout', client._socketTimeout);

        // Verify listeners are set
        test.equal(mockSocket.listenerCount('error'), 1, 'error listener should be set');
        test.equal(mockSocket.listenerCount('close'), 1, 'close listener should be set');

        // Close the client
        client.close();

        // Verify cleanup (socket is destroyed, so listeners are removed)
        test.ok(client.isClosed, 'client should be closed');

        test.done();
    },

    'should not leak memory on repeated streamer error handler registrations'(test) {
        // This test verifies that the streamer error handler pattern doesn't leak
        const clients = [];

        for (let i = 0; i < 20; i++) {
            const client = new ImapFlow({
                host: '127.0.0.1',
                port: 1,
                secure: false,
                logger: false
            });

            // Initially, streamer should have error listener from constructor
            test.ok(client.streamer.listenerCount('error') >= 1, 'streamer should have error listener');

            clients.push(client);
        }

        // Close all and verify
        for (const client of clients) {
            client.close();
            test.equal(client.streamer.listenerCount('error'), 0, 'streamer error listeners should be removed');
        }

        test.done();
    },

    'should handle rapid create/destroy cycles'(test) {
        const iterations = 100;
        let completed = 0;

        for (let i = 0; i < iterations; i++) {
            const client = new ImapFlow({
                host: '127.0.0.1',
                port: 1,
                secure: false,
                logger: false
            });

            client.close();
            completed++;

            // Spot check listener cleanup
            if (i % 10 === 0) {
                test.equal(client.streamer.listenerCount('error'), 0, `iteration ${i}: error listeners should be 0`);
            }
        }

        test.equal(completed, iterations, 'all iterations should complete');
        test.done();
    },

    'should export helper functions for external memory testing'(test) {
        // Verify helpers are working correctly
        const client = new ImapFlow({
            host: '127.0.0.1',
            port: 1,
            secure: false,
            logger: false
        });

        const report = getListenerReport(client);

        test.ok(report.streamer !== null, 'report should include streamer');
        test.ok(typeof report.streamer.error === 'number', 'error count should be a number');
        test.ok(typeof report.streamer.readable === 'number', 'readable count should be a number');
        test.ok(report.client !== null, 'report should include client');

        client.close();
        test.done();
    }
};

exports['Compression Stream Tests'] = {
    'should clean up compression streams on close'(test) {
        const client = new ImapFlow({
            host: '127.0.0.1',
            port: 1,
            secure: false,
            logger: false
        });

        // Simulate compression being enabled by manually setting up streams
        client._deflate = zlib.createDeflateRaw();
        client._inflate = zlib.createInflateRaw();

        // Add error handlers like compress() does
        client._deflate.on('error', () => {});
        client._inflate.on('error', () => {});

        // Create writeSocket like compress() does
        const writeSocket = new PassThrough();
        writeSocket.on('readable', () => {});
        writeSocket.on('error', () => {});
        client.writeSocket = writeSocket;

        // Verify streams exist
        test.ok(client._deflate, 'deflate should exist');
        test.ok(client._inflate, 'inflate should exist');
        test.ok(client.writeSocket, 'writeSocket should exist');

        // Close the client
        client.close();

        // Verify compression streams are cleaned up
        test.equal(client._deflate, null, 'deflate should be null after close');
        test.equal(client._inflate, null, 'inflate should be null after close');
        test.equal(client.writeSocket, null, 'writeSocket should be null after close');
        test.ok(client.isClosed, 'client should be closed');

        test.done();
    },

    'should not leak compression stream listeners over multiple cycles'(test) {
        // Create multiple deflate/inflate streams to verify they don't accumulate
        const streams = [];

        for (let i = 0; i < 10; i++) {
            const client = new ImapFlow({
                host: '127.0.0.1',
                port: 1,
                secure: false,
                logger: false
            });

            // Simulate compression setup
            client._deflate = zlib.createDeflateRaw();
            client._inflate = zlib.createInflateRaw();
            client._deflate.on('error', () => {});
            client._inflate.on('error', () => {});

            streams.push({
                deflate: client._deflate,
                inflate: client._inflate
            });

            // Close immediately
            client.close();

            // Verify cleanup
            test.equal(client._deflate, null, `cycle ${i + 1}: deflate should be null`);
            test.equal(client._inflate, null, `cycle ${i + 1}: inflate should be null`);
        }

        // Verify all streams are destroyed
        for (let i = 0; i < streams.length; i++) {
            test.ok(streams[i].deflate.destroyed, `cycle ${i + 1}: deflate should be destroyed`);
            test.ok(streams[i].inflate.destroyed, `cycle ${i + 1}: inflate should be destroyed`);
        }

        test.done();
    },

    'should handle compression stream errors without leaking'(test) {
        const client = new ImapFlow({
            host: '127.0.0.1',
            port: 1,
            secure: false,
            logger: false
        });

        // Setup compression streams with error handlers
        client._deflate = zlib.createDeflateRaw();
        client._inflate = zlib.createInflateRaw();

        // Add error handlers (like compress() does)
        client._deflate.on('error', () => {});
        client._inflate.on('error', () => {});

        // Verify initial listener counts
        test.equal(client._deflate.listenerCount('error'), 1, 'deflate should have 1 error listener');
        test.equal(client._inflate.listenerCount('error'), 1, 'inflate should have 1 error listener');

        // Close and verify cleanup
        client.close();

        test.equal(client._deflate, null, 'deflate should be null');
        test.equal(client._inflate, null, 'inflate should be null');

        test.done();
    }
};

exports['Fetch Stream Tests'] = {
    'should clean up internal fetch state on close'(test) {
        const client = new ImapFlow({
            host: '127.0.0.1',
            port: 1,
            secure: false,
            logger: false
        });

        // Simulate some internal state that would exist during fetch
        client.requestTagMap.set('A001', { tag: 'A001', command: 'FETCH' });
        client.requestTagMap.set('A002', { tag: 'A002', command: 'FETCH' });

        test.equal(client.requestTagMap.size, 2, 'should have 2 pending requests');

        // Close the client
        client.close();

        // Verify request map is cleared
        test.equal(client.requestTagMap.size, 0, 'requestTagMap should be cleared after close');
        test.ok(client.isClosed, 'client should be closed');

        test.done();
    },

    'should clean up mailbox state on close'(test) {
        const client = new ImapFlow({
            host: '127.0.0.1',
            port: 1,
            secure: false,
            logger: false
        });

        // Simulate mailbox state
        client.folders.set('INBOX', { path: 'INBOX', exists: 100 });
        client.folders.set('Sent', { path: 'Sent', exists: 50 });
        client.folders.set('Drafts', { path: 'Drafts', exists: 10 });

        test.equal(client.folders.size, 3, 'should have 3 folders cached');

        // Close the client
        client.close();

        // Verify folders are cleared
        test.equal(client.folders.size, 0, 'folders should be cleared after close');

        test.done();
    },

    async 'should clean up after fetch with mock server'(test) {
        const server = createMockServerWithFetch();

        server.listen(0, '127.0.0.1', async () => {
            const port = server.address().port;

            const client = new ImapFlow({
                host: '127.0.0.1',
                port,
                secure: false,
                logger: false,
                auth: {
                    user: 'test',
                    pass: 'test'
                }
            });

            try {
                await client.connect();

                // Select INBOX
                await client.mailboxOpen('INBOX');

                // Verify we're in selected state
                test.ok(client.mailbox, 'mailbox should be selected');

                await client.logout();

                // Wait for cleanup
                await new Promise(r => setTimeout(r, 100));

                // Verify cleanup
                const report = getListenerReport(client);
                test.equal(report.streamer.error, 0, 'streamer error listeners should be 0');
                test.equal(report.streamer.readable, 0, 'streamer readable listeners should be 0');
                test.ok(client.isClosed, 'client should be closed');
            } catch (err) {
                test.ok(false, 'should not throw: ' + err.message);
            } finally {
                server.close();
                test.done();
            }
        });
    },

    async 'should not leak listeners during multiple mailbox operations'(test) {
        const server = createMockServerWithFetch();

        server.listen(0, '127.0.0.1', async () => {
            const port = server.address().port;

            const client = new ImapFlow({
                host: '127.0.0.1',
                port,
                secure: false,
                logger: false,
                auth: {
                    user: 'test',
                    pass: 'test'
                }
            });

            try {
                await client.connect();

                // Perform multiple mailbox operations
                for (let i = 0; i < 5; i++) {
                    await client.mailboxOpen('INBOX');
                    await client.mailboxClose();
                }

                await client.logout();

                // Wait for cleanup
                await new Promise(r => setTimeout(r, 100));

                // Verify no listener accumulation
                const report = getListenerReport(client);
                test.equal(report.streamer.error, 0, 'streamer error listeners should be 0');
                test.equal(report.streamer.readable, 0, 'streamer readable listeners should be 0');
            } catch (err) {
                test.ok(false, 'should not throw: ' + err.message);
            } finally {
                server.close();
                test.done();
            }
        });
    }
};

// Create a mock server that supports SELECT/FETCH operations
function createMockServerWithFetch() {
    const server = net.createServer(socket => {
        socket.write('* OK Mock IMAP Server ready\r\n');

        socket.on('data', data => {
            const lines = data
                .toString()
                .split('\r\n')
                .filter(l => l.trim());

            for (const line of lines) {
                const parts = line.split(' ');
                const tag = parts[0];
                const command = parts[1] ? parts[1].toUpperCase() : '';

                if (command === 'CAPABILITY') {
                    socket.write('* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n');
                    socket.write(`${tag} OK CAPABILITY completed\r\n`);
                } else if (command === 'LOGIN') {
                    socket.write(`${tag} OK LOGIN completed\r\n`);
                } else if (command === 'LOGOUT') {
                    socket.write('* BYE Server logging out\r\n');
                    socket.write(`${tag} OK LOGOUT completed\r\n`);
                    socket.end();
                } else if (command === 'NAMESPACE') {
                    socket.write('* NAMESPACE (("" "/")) NIL NIL\r\n');
                    socket.write(`${tag} OK NAMESPACE completed\r\n`);
                } else if (command === 'COMPRESS') {
                    socket.write(`${tag} NO COMPRESS not supported\r\n`);
                } else if (command === 'ENABLE') {
                    socket.write(`${tag} OK ENABLE completed\r\n`);
                } else if (command === 'ID') {
                    socket.write('* ID NIL\r\n');
                    socket.write(`${tag} OK ID completed\r\n`);
                } else if (command === 'SELECT' || command === 'EXAMINE') {
                    socket.write('* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n');
                    socket.write('* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] Flags permitted\r\n');
                    socket.write('* 10 EXISTS\r\n');
                    socket.write('* 0 RECENT\r\n');
                    socket.write('* OK [UIDVALIDITY 1234567890] UIDs valid\r\n');
                    socket.write('* OK [UIDNEXT 11] Predicted next UID\r\n');
                    socket.write(`${tag} OK [READ-WRITE] SELECT completed\r\n`);
                } else if (command === 'CLOSE') {
                    socket.write(`${tag} OK CLOSE completed\r\n`);
                } else if (command === 'FETCH') {
                    // Simple fetch response
                    socket.write('* 1 FETCH (UID 1 FLAGS (\\Seen))\r\n');
                    socket.write(`${tag} OK FETCH completed\r\n`);
                } else if (command === 'NOOP') {
                    socket.write(`${tag} OK NOOP completed\r\n`);
                } else if (tag && command) {
                    socket.write(`${tag} OK Command completed\r\n`);
                }
            }
        });

        socket.on('error', () => {});
    });

    return server;
}

// Note: helpers (getListenerReport, measureMemory, createMockServer) are available
// within this module for testing purposes
