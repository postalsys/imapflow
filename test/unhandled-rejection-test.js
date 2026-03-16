'use strict';

/**
 * Tests for unhandled rejection prevention.
 *
 * When close() runs, it rejects pending promises synchronously. exec() and
 * getMailboxLock() attach .catch(noop) before returning, so the rejection is
 * observed immediately and does not trigger Node.js unhandledRejection.
 * These tests verify that no unhandled rejections escape while the caller
 * still receives the expected error.
 *
 * Key fix: exec() and getMailboxLock() are non-async, returning the promise
 * directly (with .catch(noop)), so the caller gets the same promise object
 * that has the noop handler. This prevents the async-wrapper double-promise
 * issue where .catch(noop) on an inner promise doesn't protect the outer
 * async wrapper promise.
 */

const net = require('net');
const { ImapFlow } = require('../lib/imap-flow');

// Create a mock IMAP server with optional custom behavior.
// options.extraCapabilities - additional capabilities (e.g., 'IDLE')
// options.onCommand(socket, tag, command) - custom handler; return true if handled
function createMockServer(options) {
    const extraCaps = options && options.extraCapabilities ? ' ' + options.extraCapabilities : '';
    const onCommand = options && options.onCommand;

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

                if (onCommand && onCommand(socket, tag, command, line)) {
                    continue;
                }

                if (command === 'CAPABILITY') {
                    socket.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN${extraCaps}\r\n`);
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
                    socket.write('* 1 EXISTS\r\n');
                    socket.write('* 1 RECENT\r\n');
                    socket.write('* OK [UIDVALIDITY 1] UIDs valid\r\n');
                    socket.write('* OK [UIDNEXT 2] Predicted next UID\r\n');
                    socket.write(`${tag} OK SELECT completed\r\n`);
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

// Helper: install an unhandledRejection detector
function installRejectionDetector(test) {
    let unhandled = false;
    let unhandledReason = null;
    const handler = reason => {
        unhandled = true;
        unhandledReason = reason;
    };
    process.on('unhandledRejection', handler);

    return {
        check() {
            process.removeListener('unhandledRejection', handler);
            test.equal(unhandled, false, 'no unhandledRejection should fire' + (unhandledReason ? ': ' + unhandledReason.message : ''));
        }
    };
}

exports['Unhandled Rejection Prevention'] = {
    'exec() + close() race should not cause unhandled rejection'(test) {
        test.expect(2);

        const client = new ImapFlow({
            host: '127.0.0.1',
            port: 1,
            secure: false,
            logger: false
        });

        // Set up state so exec() doesn't reject synchronously
        client.state = client.states.AUTHENTICATED;
        client.socket = new net.Socket();

        const detector = installRejectionDetector(test);

        // Create a pending request, then immediately close.
        // close() rejects the request synchronously. The .catch(noop) on the
        // exec() promise ensures the rejection is observed immediately.
        let promise = client.exec('NOOP');
        client.close();

        // Wait for setImmediate and microtask rejections to settle
        setTimeout(() => {
            detector.check();
            promise.catch(err => {
                test.equal(err.code, 'NoConnection', 'caller should receive NoConnection error');
                test.done();
            });
        }, 100);
    },

    'exec() on LOGOUT state should not cause unhandled rejection'(test) {
        test.expect(2);

        const client = new ImapFlow({
            host: '127.0.0.1',
            port: 1,
            secure: false,
            logger: false
        });

        client.state = client.states.LOGOUT;

        const detector = installRejectionDetector(test);

        // exec() detects LOGOUT and returns a rejected promise with .catch(noop)
        let promise = client.exec('NOOP');

        setTimeout(() => {
            detector.check();
            promise.catch(err => {
                test.equal(err.code, 'NoConnection', 'should reject with NoConnection');
                test.done();
            });
        }, 100);
    },

    'exec() with destroyed socket should not cause unhandled rejection'(test) {
        test.expect(2);

        const client = new ImapFlow({
            host: '127.0.0.1',
            port: 1,
            secure: false,
            logger: false
        });

        client.state = client.states.AUTHENTICATED;
        let sock = new net.Socket();
        sock.destroy();
        client.socket = sock;

        const detector = installRejectionDetector(test);

        let promise = client.exec('NOOP');

        setTimeout(() => {
            detector.check();
            promise.catch(err => {
                test.equal(err.code, 'EConnectionClosed', 'should reject with EConnectionClosed');
                test.done();
            });
        }, 100);
    },

    'multiple pending exec() + close() should not cause unhandled rejections'(test) {
        test.expect(7);

        const client = new ImapFlow({
            host: '127.0.0.1',
            port: 1,
            secure: false,
            logger: false
        });

        client.state = client.states.AUTHENTICATED;
        client.socket = new net.Socket();

        const detector = installRejectionDetector(test);

        let p1 = client.exec('NOOP');
        let p2 = client.exec('NOOP');
        let p3 = client.exec('NOOP');
        client.close();

        setTimeout(() => {
            detector.check();

            let settled = 0;
            const checkDone = () => {
                if (++settled === 3) {
                    test.done();
                }
            };

            p1.catch(err => {
                test.ok(err, 'p1 should reject');
                test.equal(err.code, 'NoConnection', 'p1 error code');
                checkDone();
            });
            p2.catch(err => {
                test.ok(err, 'p2 should reject');
                test.equal(err.code, 'NoConnection', 'p2 error code');
                checkDone();
            });
            p3.catch(err => {
                test.ok(err, 'p3 should reject');
                test.equal(err.code, 'NoConnection', 'p3 error code');
                checkDone();
            });
        }, 100);
    },

    'getMailboxLock() + close() race should not cause unhandled rejection'(test) {
        test.expect(2);

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

            const detector = installRejectionDetector(test);

            try {
                await client.connect();

                // Request a lock, then immediately close before it resolves.
                // close() rejects pending locks synchronously.
                let lockPromise = client.getMailboxLock('INBOX');
                client.close();

                try {
                    await lockPromise;
                    test.ok(false, 'lockPromise should have rejected');
                } catch (err) {
                    // Wait for any deferred unhandled rejection
                    await new Promise(r => setTimeout(r, 100));
                    detector.check();
                    test.equal(err.code, 'NoConnection', 'caller should receive NoConnection error');
                }
            } catch (err) {
                detector.check();
                test.ok(false, 'unexpected error: ' + err.message);
            } finally {
                server.close(() => test.done());
            }
        });
    },

    'connect() + close() during greeting timeout should not cause unhandled rejection'(test) {
        test.expect(2);

        // Server that accepts TCP but never sends a greeting.
        // The client's greetingTimeout will fire.
        const server = net.createServer(socket => {
            // Intentionally send nothing - let client timeout
            socket.on('error', () => {});
        });

        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;

            const client = new ImapFlow({
                host: '127.0.0.1',
                port,
                secure: false,
                logger: false,
                greetingTimeout: 200,
                auth: {
                    user: 'test',
                    pass: 'test'
                }
            });

            const detector = installRejectionDetector(test);

            // Close shortly after the TCP connection is established but
            // before the greeting is received
            const origSetSocket = client.setSocketHandlers;
            let closeTriggered = false;
            client.setSocketHandlers = function () {
                origSetSocket.call(this);
                if (!closeTriggered) {
                    closeTriggered = true;
                    // Close on the next tick to simulate race
                    setImmediate(() => client.close());
                }
            };

            client.connect().then(
                () => {
                    detector.check();
                    test.ok(false, 'connect() should have rejected');
                    server.close(() => test.done());
                },
                err => {
                    setTimeout(() => {
                        detector.check();
                        test.ok(err && err.code, 'connect() should reject with an error code');
                        server.close(() => test.done());
                    }, 100);
                }
            );
        });
    },

    'BYE during IDLE should not cause unhandled rejection (Death 1)'(test) {
        test.expect(2);

        const server = createMockServer({
            extraCapabilities: 'IDLE',
            onCommand(socket, tag, command) {
                if (command === 'IDLE') {
                    socket.write('+ idling\r\n');
                    // After a short delay, send BYE and close (simulates token expiry)
                    setTimeout(() => {
                        try {
                            socket.write('* BYE Session invalidated - AccessTokenExpired\r\n');
                            socket.end();
                        } catch {
                            // socket may already be closed
                        }
                    }, 50);
                    return true;
                }
            }
        });

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

            const detector = installRejectionDetector(test);

            try {
                await client.connect();
                await client.mailboxOpen('INBOX');

                // Start IDLE and wait for the BYE-triggered close
                await new Promise((resolve, reject) => {
                    client.idle().catch(() => {
                        // Expected: IDLE rejects when BYE arrives
                    });

                    client.on('close', () => {
                        // Wait for any deferred unhandled rejections to surface
                        setTimeout(resolve, 100);
                    });

                    // Safety timeout
                    setTimeout(() => reject(new Error('Timeout waiting for close')), 5000);
                });

                detector.check();
                test.ok(true, 'No unhandled rejection during IDLE + BYE');
            } catch (err) {
                detector.check();
                test.ok(false, 'Unexpected error: ' + err.message);
            } finally {
                server.close(() => test.done());
            }
        });
    },

    'BAD response to FETCH should not cause unhandled rejection (Death 2)'(test) {
        test.expect(3);

        const server = createMockServer({
            onCommand(socket, tag, command) {
                if (command === 'UID' || command === 'FETCH') {
                    // Simulate "Server Unavailable" error for any FETCH variant
                    socket.write(`${tag} BAD Server Unavailable. 15\r\n`);
                    return true;
                }
            }
        });

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

            const detector = installRejectionDetector(test);

            try {
                await client.connect();
                await client.mailboxOpen('INBOX');

                // Attempt a FETCH that will get BAD response
                try {
                    await client.fetchOne('*', { uid: true }, { uid: true });
                    test.ok(false, 'fetchOne should have rejected');
                } catch (err) {
                    test.equal(err.message, 'Command failed', 'Should get Command failed error');
                    test.equal(err.responseStatus, 'BAD', 'Response status should be BAD');
                }

                // Wait for any deferred unhandled rejections
                await new Promise(r => setTimeout(r, 100));
                detector.check();

                client.close();
            } catch (err) {
                detector.check();
                test.ok(false, 'Unexpected error: ' + err.message);
            } finally {
                server.close(() => test.done());
            }
        });
    }
};
