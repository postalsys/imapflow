import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import idleCommand from '../src/commands/idle.js';
import { withFakeTimers } from './fixtures/fake-timers.js';
import { makeClient, makeIdleReadyClient } from './fixtures/test-client.js';

// Timer process-liveness policy:
//   * connection establishment and greeting deadlines keep the process alive, because a caller is
//     waiting for connect() to settle
//   * background timers (auto-IDLE, IDLE restart, fallback polling, throttle back-off) are unref'd
//   * every timer is cleared explicitly on close()
//
// Asserted through timer identity and cleanup rather than wall-clock sleeps.

const CAPS = 'IMAP4rev1 ID ENABLE NAMESPACE IDLE';

const createServer = () =>
    net.createServer(socket => {
        socket.setNoDelay(true);
        socket.on('error', () => {});
        let buf = '';
        socket.on('data', data => {
            buf += data.toString('binary');
            let idx;
            while ((idx = buf.indexOf('\r\n')) >= 0) {
                let line = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                let parts = line.split(' ');
                let tag = parts[0];
                let cmd = (parts[1] || '').toUpperCase();
                switch (cmd) {
                    case 'CAPABILITY':
                        socket.write(`* CAPABILITY ${CAPS}\r\n${tag} OK done\r\n`);
                        break;
                    case 'ID':
                        socket.write(`* ID ("name" "mock")\r\n${tag} OK done\r\n`);
                        break;
                    case 'NAMESPACE':
                        socket.write(`* NAMESPACE (("" "/")) NIL NIL\r\n${tag} OK done\r\n`);
                        break;
                    case 'LOGOUT':
                        socket.write(`* BYE bye\r\n${tag} OK done\r\n`);
                        break;
                    default:
                        socket.write(`${tag} OK ok\r\n`);
                }
            }
        });
        socket.write(`* OK [CAPABILITY ${CAPS}] ready\r\n`);
    });

const listen = (server: any) => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

describe('timer-policy', () => {
    it('Timers: connection and greeting deadlines keep the process alive', async () => {
        let server = createServer();
        let port = await listen(server);

        await withFakeTimers(async timers => {
            let client = makeClient({
                port,
                secure: false,
                connectionTimeout: 12345,
                greetingTimeout: 6789,
                disableAutoIdle: true,
                disableCompression: true
            });
            client.on('error', () => {});

            await client.connect();

            let connectDeadline = timers.history().find(timer => timer.delay === 12345);
            let greetingDeadline = timers.history().find(timer => timer.delay === 6789);

            assert.ok(connectDeadline, 'the connection deadline was armed');
            assert.equal(connectDeadline.unrefd, false, 'the connection deadline keeps the process alive');
            assert.ok(connectDeadline.cleared, 'and is cleared once the transport is established');

            assert.ok(greetingDeadline, 'the greeting deadline was armed');
            assert.equal(greetingDeadline.unrefd, false, 'the greeting deadline keeps the process alive');
            assert.ok(greetingDeadline.cleared, 'and is cleared once the greeting arrives');

            client.close();
            assert.equal(timers.count(), 0, 'no timer is left armed after close');
        });

        server.close();
    });
    it('Timers: the auto-IDLE timer is unrefd and cleared on close', async () => {
        await withFakeTimers(async timers => {
            let client = makeIdleReadyClient();

            client.autoidle();

            let armed = timers.pending();
            assert.equal(armed.length, 1, 'exactly one auto-IDLE timer is armed');
            assert.equal(armed[0].delay, client.autoIdleDelay);
            assert.ok(armed[0].unrefd, 'the background auto-IDLE timer does not keep the process alive');

            client.close();
            assert.equal(timers.count(), 0, 'close() clears the auto-IDLE timer');
            assert.ok(timers.history()[0].cleared, 'the timer was cleared, not just abandoned');
        });
    });
    it('Timers: a restarted auto-IDLE timer replaces the previous one', (t, done) => {
        (async () => {
            await withFakeTimers(async timers => {
                let client = makeIdleReadyClient();

                client.autoidle();
                client.autoidle();

                assert.equal(timers.count(), 1, 'only the newest auto-IDLE timer stays armed');
                assert.ok(timers.history()[0].cleared, 'the superseded timer was cleared');

                client.close();
                done();
            });
        })().catch(done);
    });
    it('Timers: the IDLE restart timer is unrefd', (t, done) => {
        (async () => {
            await withFakeTimers(async timers => {
                const states = { NOT_AUTHENTICATED: 1, AUTHENTICATED: 2, SELECTED: 3, LOGOUT: 4 };
                let breakIdle: any;

                const connection: any = {
                    states,
                    state: states.SELECTED,
                    id: 'timer-test',
                    capabilities: new Map([['IDLE', true]]),
                    enabled: new Set(),
                    mailbox: { path: 'INBOX' },
                    socket: { destroyed: false },
                    idling: false,
                    preCheck: false,
                    log: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {}, trace: () => {} },
                    write: () => {},
                    exec: async (command: any, attributes: any, options: any) => {
                        await options.onPlusTag();
                        await new Promise(resolve => (breakIdle = resolve));
                        return { next: () => {} };
                    }
                };

                let idlePromise = idleCommand(connection, 30000);
                await timers.drain();

                let armed = timers.pending();
                assert.equal(armed.length, 1, 'the IDLE restart timer is armed');
                assert.equal(armed[0].delay, 30000);
                assert.ok(armed[0].unrefd, 'the background IDLE restart timer does not keep the process alive');

                breakIdle();
                await idlePromise;
                assert.equal(timers.count(), 0, 'the restart timer is cleared when IDLE ends');
                done();
            });
        })().catch(done);
    });
    it('Timers: the throttle back-off timer is unrefd and cleared', (t, done) => {
        (async () => {
            await withFakeTimers(async timers => {
                let client = makeClient();
                client.socket = { destroyed: false, destroy: () => {} };
                client.writeSocket = client.socket;

                let request = { tag: 'A001', command: 'FETCH', resolve: () => {}, reject: () => {} };
                client.requestTagMap = new Map([['A001', request]]);
                client.currentRequest = { tag: 'A001', command: 'FETCH', sent: true };

                let served = false;
                client.streamer.read = () => {
                    if (served) {
                        return null;
                    }
                    served = true;
                    return {
                        payload: Buffer.from('A001 BAD Request is throttled. Suggested Backoff Time: 300000 milliseconds'),
                        literals: [],
                        next: () => {}
                    };
                };

                let readerDone = client.reader().catch(() => {});
                await timers.drain();

                let backoff = timers.history().find(timer => timer.delay === 300000);
                assert.ok(backoff, 'the throttle back-off timer is armed');
                assert.ok(backoff.unrefd, 'the back-off timer does not keep the process alive');

                client.close();
                await readerDone;

                // history() returns snapshots, so re-read it after close()
                assert.ok(timers.history().find(timer => timer.id === backoff.id)!.cleared, 'close() clears the back-off timer');
                assert.equal(client._throttleWaits.size, 0);
                done();
            });
        })().catch(done);
    });
    it('Timers: throttleWait caps a server-suggested back-off', (t, done) => {
        (async () => {
            // The delay comes straight from a server hint (a Microsoft 365 "Suggested Backoff Time"),
            // which is unbounded. Asserted on the armed timer rather than by waiting it out.
            await withFakeTimers(async timers => {
                let client = makeClient({ port: 1 });

                let pending = client.throttleWait(7 * 24 * 3600 * 1000); // a week
                let armed = timers.history()[timers.history().length - 1];
                assert.equal(armed.delay, 5 * 60 * 1000, 'the back-off is capped at five minutes');
                assert.ok(armed.unrefd, 'the back-off timer must not keep the process alive');

                client.close();
                assert.equal(await pending, true, 'close() aborts the wait');
                assert.ok(timers.history().find(timer => timer.id === armed.id)!.cleared, 'close() clears the timer');

                // a delay under the cap is honored as given, and junk becomes an immediate wait
                let client2 = makeClient({ port: 1 });
                client2.throttleWait(1500);
                assert.equal(timers.history()[timers.history().length - 1].delay, 1500);
                client2.throttleWait('nonsense');
                assert.equal(timers.history()[timers.history().length - 1].delay, 0);
                client2.close();
                done();
            });
        })().catch(done);
    });
});
