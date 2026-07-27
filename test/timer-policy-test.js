'use strict';

// Timer process-liveness policy:
//   * connection establishment and greeting deadlines keep the process alive, because a caller is
//     waiting for connect() to settle
//   * background timers (auto-IDLE, IDLE restart, fallback polling, throttle back-off) are unref'd
//   * every timer is cleared explicitly on close()
//
// Asserted through timer identity and cleanup rather than wall-clock sleeps.

const net = require('net');
const { ImapFlow } = require('../lib/imap-flow');
const idleCommand = require('../lib/commands/idle.js');
const { withFakeTimers } = require('./fixtures/fake-timers');

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

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

const makeClient = (overrides = {}) =>
    new ImapFlow({
        host: '127.0.0.1',
        port: 993,
        logger: false,
        auth: { user: 'test', pass: 'secret' },
        ...overrides
    });

module.exports['Timers: connection and greeting deadlines keep the process alive'] = async test => {
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

        test.ok(connectDeadline, 'the connection deadline was armed');
        test.equal(connectDeadline.unrefd, false, 'the connection deadline keeps the process alive');
        test.ok(connectDeadline.cleared, 'and is cleared once the transport is established');

        test.ok(greetingDeadline, 'the greeting deadline was armed');
        test.equal(greetingDeadline.unrefd, false, 'the greeting deadline keeps the process alive');
        test.ok(greetingDeadline.cleared, 'and is cleared once the greeting arrives');

        client.close();
        test.equal(timers.count(), 0, 'no timer is left armed after close');
    });

    server.close();
    test.done();
};

module.exports['Timers: the auto-IDLE timer is unrefd and cleared on close'] = async test => {
    await withFakeTimers(async timers => {
        let client = makeClient();
        client.state = client.states.SELECTED;
        client.idle = async () => {};

        client.autoidle();

        let armed = timers.pending();
        test.equal(armed.length, 1, 'exactly one auto-IDLE timer is armed');
        test.equal(armed[0].delay, 15 * 1000);
        test.ok(armed[0].unrefd, 'the background auto-IDLE timer does not keep the process alive');

        client.close();
        test.equal(timers.count(), 0, 'close() clears the auto-IDLE timer');
        test.ok(timers.history()[0].cleared, 'the timer was cleared, not just abandoned');
    });
    test.done();
};

module.exports['Timers: a restarted auto-IDLE timer replaces the previous one'] = async test => {
    await withFakeTimers(async timers => {
        let client = makeClient();
        client.state = client.states.SELECTED;
        client.idle = async () => {};

        client.autoidle();
        client.autoidle();

        test.equal(timers.count(), 1, 'only the newest auto-IDLE timer stays armed');
        test.ok(timers.history()[0].cleared, 'the superseded timer was cleared');

        client.close();
        test.done();
    });
};

module.exports['Timers: the IDLE restart timer is unrefd'] = async test => {
    await withFakeTimers(async timers => {
        const states = { NOT_AUTHENTICATED: 1, AUTHENTICATED: 2, SELECTED: 3, LOGOUT: 4 };
        let breakIdle;

        const connection = {
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
            exec: async (command, attributes, options) => {
                await options.onPlusTag();
                await new Promise(resolve => (breakIdle = resolve));
                return { next: () => {} };
            }
        };

        let idlePromise = idleCommand(connection, 30000);
        await timers.drain();

        let armed = timers.pending();
        test.equal(armed.length, 1, 'the IDLE restart timer is armed');
        test.equal(armed[0].delay, 30000);
        test.ok(armed[0].unrefd, 'the background IDLE restart timer does not keep the process alive');

        breakIdle();
        await idlePromise;
        test.equal(timers.count(), 0, 'the restart timer is cleared when IDLE ends');
        test.done();
    });
};

module.exports['Timers: the throttle back-off timer is unrefd and cleared'] = async test => {
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
        test.ok(backoff, 'the throttle back-off timer is armed');
        test.ok(backoff.unrefd, 'the back-off timer does not keep the process alive');

        client.close();
        await readerDone;

        // history() returns snapshots, so re-read it after close()
        test.ok(timers.history().find(timer => timer.id === backoff.id).cleared, 'close() clears the back-off timer');
        test.equal(client._throttleTimer, null);
        test.done();
    });
};
