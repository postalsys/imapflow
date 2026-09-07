import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ImapFlow } from '../src/imap-flow.js';
import { installRejectionDetector, slowConsumer } from './fixtures/test-client.js';

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

// Create a mock IMAP server with optional custom behavior.
// options.extraCapabilities - additional capabilities (e.g., 'IDLE')
// options.onCommand(socket, tag, command) - custom handler; return true if handled
function createMockServer(options: any) {
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

// Drives a connection to the one state both IDLE-waiter tests need: IDLE issued but never
// acknowledged with a "+", so preCheck() cannot send DONE and anything it queues stays queued
// until close() tears the IDLE command down. Hands the connected client to `run`, and always
// closes the server so the test ends.
function withQueuedIdleWaiter(done: (err?: any) => void, options: any, run: (client: any) => Promise<void>, onError?: (err: any) => void) {
    const server: any = createMockServer({
        extraCapabilities: 'IDLE',
        onCommand(socket: any, tag: any, command: any) {
            if (command === 'IDLE') {
                return true;
            }
        }
    });

    server.listen(0, '127.0.0.1', async () => {
        const client = new ImapFlow(
            Object.assign(
                {
                    host: '127.0.0.1',
                    port: (server.address() as any).port,
                    secure: false,
                    logger: false,
                    disableAutoIdle: true,
                    auth: { user: 'test', pass: 'test' }
                },
                options
            )
        );

        let failure: Error | null = null;
        try {
            await client.connect();
            await client.mailboxOpen('INBOX');

            client.idle().catch(() => {
                // Expected: IDLE rejects when the connection is closed
            });

            // Let the IDLE command reach the server and install preCheck()
            await new Promise(r => setTimeout(r, 100));
            assert.equal(typeof client.preCheck, 'function', 'IDLE should have installed preCheck()');

            await run(client);
        } catch (err: any) {
            if (onError) {
                onError(err);
            }
            failure = new Error('Unexpected error: ' + err.message);
        } finally {
            server.close(() => done(failure || undefined));
        }
    });
}

describe('unhandled-rejection', () => {
    describe('Unhandled Rejection Prevention', () => {
        it('exec() + close() race should not cause unhandled rejection', (t, done) => {
            const client = new ImapFlow({
                host: '127.0.0.1',
                port: 1,
                secure: false,
                logger: false
            });

            // Set up state so exec() doesn't reject synchronously
            client.state = client.states.AUTHENTICATED;
            client.socket = new net.Socket();

            const detector = installRejectionDetector();

            // Create a pending request, then immediately close.
            // close() rejects the request synchronously. The .catch(noop) on the
            // exec() promise ensures the rejection is observed immediately.
            let promise = client.exec('NOOP');
            client.close();

            // Wait for setImmediate and microtask rejections to settle
            setTimeout(() => {
                detector.check();
                promise.catch(err => {
                    assert.equal(err.code, 'NoConnection', 'caller should receive NoConnection error');
                    done();
                });
            }, 100);
        });

        it('exec() on LOGOUT state should not cause unhandled rejection', (t, done) => {
            const client = new ImapFlow({
                host: '127.0.0.1',
                port: 1,
                secure: false,
                logger: false
            });

            client.state = client.states.LOGOUT;

            const detector = installRejectionDetector();

            // exec() detects LOGOUT and returns a rejected promise with .catch(noop)
            let promise = client.exec('NOOP');

            setTimeout(() => {
                detector.check();
                promise.catch(err => {
                    assert.equal(err.code, 'NoConnection', 'should reject with NoConnection');
                    done();
                });
            }, 100);
        });

        it('exec() with destroyed socket should not cause unhandled rejection', (t, done) => {
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

            const detector = installRejectionDetector();

            let promise = client.exec('NOOP');

            setTimeout(() => {
                detector.check();
                promise.catch(err => {
                    assert.equal(err.code, 'EConnectionClosed', 'should reject with EConnectionClosed');
                    done();
                });
            }, 100);
        });

        it('multiple pending exec() + close() should not cause unhandled rejections', (t, done) => {
            const client = new ImapFlow({
                host: '127.0.0.1',
                port: 1,
                secure: false,
                logger: false
            });

            client.state = client.states.AUTHENTICATED;
            client.socket = new net.Socket();

            const detector = installRejectionDetector();

            let p1 = client.exec('NOOP');
            let p2 = client.exec('NOOP');
            let p3 = client.exec('NOOP');
            client.close();

            setTimeout(() => {
                detector.check();

                let settled = 0;
                const checkDone = () => {
                    if (++settled === 3) {
                        return done();
                    }
                };

                p1.catch(err => {
                    assert.ok(err, 'p1 should reject');
                    assert.equal(err.code, 'NoConnection', 'p1 error code');
                    checkDone();
                });
                p2.catch(err => {
                    assert.ok(err, 'p2 should reject');
                    assert.equal(err.code, 'NoConnection', 'p2 error code');
                    checkDone();
                });
                p3.catch(err => {
                    assert.ok(err, 'p3 should reject');
                    assert.equal(err.code, 'NoConnection', 'p3 error code');
                    checkDone();
                });
            }, 100);
        });

        it('getMailboxLock() + close() race should not cause unhandled rejection', (t, done) => {
            const server: any = (createMockServer as any)();

            server.listen(0, '127.0.0.1', async () => {
                const port = (server.address() as any).port;

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

                const detector = installRejectionDetector();

                try {
                    await client.connect();

                    // Request a lock, then immediately close before it resolves.
                    // close() rejects pending locks synchronously.
                    let lockPromise = client.getMailboxLock('INBOX');
                    client.close();

                    try {
                        await lockPromise;
                        assert.ok(false, 'lockPromise should have rejected');
                    } catch (err: any) {
                        // Wait for any deferred unhandled rejection
                        await new Promise(r => setTimeout(r, 100));
                        detector.check();
                        assert.equal(err.code, 'NoConnection', 'caller should receive NoConnection error');
                    }
                } catch (err: any) {
                    detector.check();
                    assert.ok(false, 'unexpected error: ' + err.message);
                } finally {
                    server.close(() => done());
                }
            });
        });

        it('connect() + close() during greeting timeout should not cause unhandled rejection', (t, done) => {
            // Server that accepts TCP but never sends a greeting.
            // The client's greetingTimeout will fire.
            const server: any = net.createServer(socket => {
                // Intentionally send nothing - let client timeout
                socket.on('error', () => {});
            });

            server.listen(0, '127.0.0.1', () => {
                const port = (server.address() as any).port;

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

                const detector = installRejectionDetector();

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
                        assert.ok(false, 'connect() should have rejected');
                        server.close(() => done());
                    },
                    err => {
                        setTimeout(() => {
                            detector.check();
                            assert.ok(err && err.code, 'connect() should reject with an error code');
                            server.close(() => done());
                        }, 100);
                    }
                );
            });
        });

        it('BYE during IDLE should not cause unhandled rejection (Death 1)', (t, done) => {
            const server: any = createMockServer({
                extraCapabilities: 'IDLE',
                onCommand(socket: any, tag: any, command: any) {
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
                const port = (server.address() as any).port;

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

                const detector = installRejectionDetector();

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
                    assert.ok(true, 'No unhandled rejection during IDLE + BYE');
                } catch (err: any) {
                    detector.check();
                    assert.ok(false, 'Unexpected error: ' + err.message);
                } finally {
                    server.close(() => done());
                }
            });
        });

        it('close() stamps the rejection site, command and connection id on the error', (t, done) => {
            const client = new ImapFlow({
                host: '127.0.0.1',
                port: 1,
                secure: false,
                logger: false,
                id: 'test-cid'
            });

            client.state = client.states.AUTHENTICATED;
            client.socket = new net.Socket();

            const detector = installRejectionDetector();

            let promise = client.exec('NOOP');
            client.close();

            setTimeout(() => {
                detector.check();
                promise.catch(err => {
                    assert.equal(err.code, 'NoConnection', 'caller should receive NoConnection error');
                    assert.equal(err.rejectedFrom, 'pendingRequest', 'error should name the rejection site');
                    assert.equal(err.command, 'NOOP', 'error should name the command it belonged to');
                    assert.equal(err.cid, 'test-cid', 'error should carry the connection id');
                    done();
                });
            }, 100);
        });

        it('a preCheck() waiter rejection names its own site, not the IDLE command', (t, done) => {
            withQueuedIdleWaiter(done, { id: 'waiter-cid' }, async client => {
                let waiter = client.preCheck();
                client.close();

                try {
                    await waiter;
                    assert.ok(false, 'the waiter should have rejected');
                } catch (err: any) {
                    assert.equal(err.rejectedFrom, 'preCheckWaiter', 'the waiter names its own rejection site');
                    assert.equal(err.cid as any, 'waiter-cid', 'the waiter error carries the connection id');
                    assert.equal(err.code as any, 'NoConnection', 'the original code is preserved for callers that branch on it');
                    assert.strictEqual(err.command as any, undefined, 'the command belongs to the site the error came from, not to the waiter');
                    assert.ok(err.cause as any, 'the command failure travels on as the cause');
                    assert.equal(err.cause.rejectedFrom as any, 'pendingRequest', 'the cause still names the command site');
                    assert.equal(err.cause.command as any, 'IDLE', 'the cause still names the command');
                }
            });
        });

        it('preCheck() waiter rejected by close() should not cause unhandled rejection', (t, done) => {
            const detector = installRejectionDetector();

            withQueuedIdleWaiter(
                done,
                {},
                async client => {
                    // Request an IDLE break and drop the returned promise on the floor, so the queued
                    // waiter has no handler of its own when close() rejects it
                    client.preCheck();
                    client.close();

                    await new Promise(r => setTimeout(r, 100));
                    detector.check();
                },
                () => detector.check()
            );
        });

        it('BAD response to FETCH should not cause unhandled rejection (Death 2)', (t, done) => {
            const server: any = createMockServer({
                onCommand(socket: any, tag: any, command: any) {
                    if (command === 'UID' || command === 'FETCH') {
                        // Simulate "Server Unavailable" error for any FETCH variant
                        socket.write(`${tag} BAD Server Unavailable. 15\r\n`);
                        return true;
                    }
                }
            });

            server.listen(0, '127.0.0.1', async () => {
                const port = (server.address() as any).port;

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

                const detector = installRejectionDetector();

                try {
                    await client.connect();
                    await client.mailboxOpen('INBOX');

                    // Attempt a FETCH that will get BAD response
                    try {
                        await client.fetchOne('*', { uid: true }, { uid: true });
                        assert.ok(false, 'fetchOne should have rejected');
                    } catch (err: any) {
                        assert.equal(err.message, 'Command failed', 'Should get Command failed error');
                        assert.equal(err.responseStatus as any, 'BAD', 'Response status should be BAD');
                    }

                    // Wait for any deferred unhandled rejections
                    await new Promise(r => setTimeout(r, 100));
                    detector.check();

                    client.close();
                } catch (err: any) {
                    detector.check();
                    assert.ok(false, 'Unexpected error: ' + err.message);
                } finally {
                    server.close(() => done());
                }
            });
        });

        it('a download losing its connection mid-chunk should not cause unhandled rejection (Death 3)', (t, done) => {
            // The reported production crash, end to end over a real socket: a chunked download whose
            // consumer is applying backpressure, and a connection that goes away with the next
            // UID FETCH in flight. close() rejects that pending request, and the rejection has to
            // reach the content stream rather than a promise nobody holds.

            const CHUNK = 64 * 1024;
            const TOTAL = CHUNK * 8;
            let fetchCount = 0;

            const server: any = createMockServer({
                onCommand(socket: any, tag: any, command: any) {
                    if (command !== 'UID') {
                        return;
                    }

                    fetchCount++;
                    if (fetchCount > 3) {
                        // the production event: the socket ends with a UID FETCH pending
                        socket.destroy();
                        return true;
                    }

                    // one BODY[]<offset> chunk, in the literal form download() asks for
                    socket.write(`* 1 FETCH (UID 1 RFC822.SIZE ${TOTAL} BODY[]<${(fetchCount - 1) * CHUNK}> {${CHUNK}}\r\n`);
                    socket.write(Buffer.alloc(CHUNK, 0x61));
                    socket.write(')\r\n');
                    socket.write(`${tag} OK FETCH completed\r\n`);
                    return true;
                }
            });

            server.listen(0, '127.0.0.1', async () => {
                const client = new ImapFlow({
                    host: '127.0.0.1',
                    port: (server.address() as any).port,
                    secure: false,
                    logger: false,
                    disableAutoIdle: true,
                    auth: { user: 'test', pass: 'test' }
                });

                // the connection is destroyed under the client on purpose
                client.on('error', () => false);

                const detector = installRejectionDetector();

                try {
                    await client.connect();
                    await client.mailboxOpen('INBOX');

                    let { content }: any = await client.download('1', false as any, { uid: true, chunkSize: CHUNK });

                    let received = 0;
                    let streamErr: any = null;
                    content.on('error', (err: any) => {
                        streamErr = err;
                    });
                    // The delay is load-bearing: it has to outlast a loopback round trip, or the
                    // pipeline drains between chunks, writeChunk() never returns false, and the
                    // backpressure wait this test exists for is never entered
                    content!.pipe(slowConsumer({ delay: 30, onChunk: chunk => (received += chunk.length) }));

                    await new Promise(resolve => {
                        content!.on('close', resolve);
                        content!.on('error', resolve);
                    });
                    await new Promise(r => setTimeout(r, 100));
                    detector.check();

                    assert.ok(received >= CHUNK, 'a chunk drained through the consumer before the connection went away');
                    assert.ok(streamErr, 'the failure surfaced on the content stream');
                    assert.equal(streamErr && streamErr.code, 'NoConnection', 'the caller gets the connection error');

                    client.close();
                } catch (err: any) {
                    detector.check();
                    assert.ok(false, 'Unexpected error: ' + err.message);
                } finally {
                    server.close(() => done());
                }
            });
        });
    });
});
