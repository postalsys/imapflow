'use strict';

// Tagged response correlation: a tagged response may only complete the command that was
// actually written to the socket. A response for a queued-but-unsent command is proof of
// desynchronization and fails the connection closed; a wholly unknown tag is recorded but
// tolerated, because non-conforming servers do emit stray tagged lines.

const net = require('net');
const { ImapFlow } = require('../lib/imap-flow');

const CAPABILITIES = 'IMAP4rev1 ID ENABLE NAMESPACE';

// Minimal scriptable IMAP server. `onCommand(ctx)` may fully handle a command by returning
// true; otherwise the default happy-path session responses are used.
const createServer = onCommand =>
    net.createServer(socket => {
        socket.setNoDelay(true);
        socket.on('error', () => {});
        socket.write(`* OK [CAPABILITY ${CAPABILITIES}] mock ready\r\n`);

        let buf = '';
        socket.on('data', data => {
            buf += data.toString('binary');
            let idx;
            while ((idx = buf.indexOf('\r\n')) >= 0) {
                let line = buf.slice(0, idx);
                buf = buf.slice(idx + 2);

                let parts = line.split(' ');
                let ctx = {
                    tag: parts[0],
                    command: (parts[1] || '').toUpperCase(),
                    socket,
                    write: str => socket.write(str),
                    ok: text => socket.write(`${parts[0]} OK ${text || 'completed'}\r\n`)
                };

                if (onCommand && onCommand(ctx)) {
                    continue;
                }

                switch (ctx.command) {
                    case 'CAPABILITY':
                        ctx.write(`* CAPABILITY ${CAPABILITIES}\r\n`);
                        ctx.ok();
                        break;
                    case 'NAMESPACE':
                        ctx.write('* NAMESPACE (("" "/")) NIL NIL\r\n');
                        ctx.ok();
                        break;
                    case 'ID':
                        ctx.write('* ID ("name" "mock")\r\n');
                        ctx.ok();
                        break;
                    default:
                        ctx.ok();
                }
            }
        });
    });

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

// Captures warn/error entries so bounded logging can be asserted.
const createLogger = () => {
    const entries = { warn: [], error: [] };
    const noop = () => {};
    return {
        trace: noop,
        debug: noop,
        info: noop,
        warn: entry => entries.warn.push(entry),
        error: entry => entries.error.push(entry),
        fatal: noop,
        entries
    };
};

const makeClient = (port, overrides = {}) =>
    new ImapFlow({
        host: '127.0.0.1',
        port,
        secure: false,
        disableAutoIdle: true,
        disableCompression: true,
        logger: false,
        auth: { user: 'test', pass: 'secret' },
        ...overrides
    });

// Command tags are sequential hex counters, so a server can trivially guess the tag of a
// command that has been queued but not yet sent.
const nextTag = tag => (parseInt(tag, 16) + 1).toString(16).toUpperCase();

module.exports['Tag correlation: response for a queued but unsent command closes the connection'] = async test => {
    let server = createServer(ctx => {
        if (ctx.command !== 'NOOP') {
            return false;
        }
        // Answer with the tag of the command still sitting in the queue
        ctx.write(`${nextTag(ctx.tag)} OK forged completion\r\n`);
        return true;
    });
    let port = await listen(server);
    let client = makeClient(port);

    let errors = [];
    client.on('error', err => errors.push(err));

    await client.connect();

    let first = client.exec('NOOP', false, {});
    let second = client.exec('NOOP', false, {});

    let firstErr = await first.then(() => null).catch(err => err);
    let secondErr = await second.then(() => null).catch(err => err);

    test.ok(secondErr, 'the queued command did not resolve from a response it never asked for');
    test.equal(secondErr.code, 'UnexpectedTag', 'the queued command rejects with the protocol error');
    test.ok(secondErr.details.received, 'the received tag is recorded');
    test.equal(secondErr.details.received, nextTag(secondErr.details.expected), 'the received tag is the queued (unsent) tag');

    test.ok(firstErr, 'the in-flight command also rejects rather than hanging');
    test.ok(['UnexpectedTag', 'NoConnection'].includes(firstErr.code), `in-flight command rejected with ${firstErr.code}`);

    test.ok(
        errors.some(err => err.code === 'UnexpectedTag'),
        'the desynchronization is reported to the caller'
    );
    test.ok(!client.usable, 'the connection is no longer usable');

    client.close();
    server.close();
    test.done();
};

module.exports['Tag correlation: unknown tag is counted and survived'] = async test => {
    let logger = createLogger();
    let server = createServer(ctx => {
        if (ctx.command !== 'NOOP') {
            return false;
        }
        ctx.write('ZZZZ OK stray response\r\n');
        ctx.ok('NOOP completed');
        return true;
    });
    let port = await listen(server);
    let client = makeClient(port, { logger });

    let errors = [];
    client.on('error', err => errors.push(err));

    await client.connect();
    test.equal(client._unknownTagCount, 0, 'a normal session issues no unknown tags');

    let response = await client.exec('NOOP', false, {});
    response.next();

    test.equal(client._unknownTagCount, 1, 'the stray tagged line is counted');
    test.ok(client.usable, 'the connection survives a stray tagged line');
    test.deepEqual(errors, [], 'no error is emitted for a merely unknown tag');
    test.ok(
        logger.entries.warn.some(entry => entry.msg === 'Tagged response for an unknown tag' && entry.tag === 'ZZZZ'),
        'the stray tag is logged at warn level'
    );

    await client.logout();
    client.close();
    server.close();
    test.done();
};

module.exports['Tag correlation: unknown tag warnings are bounded but the count stays exact'] = async test => {
    const strayCount = 10;
    let logger = createLogger();
    let server = createServer(ctx => {
        if (ctx.command !== 'NOOP') {
            return false;
        }
        for (let i = 0; i < strayCount; i++) {
            ctx.write(`STRAY${i} OK stray response\r\n`);
        }
        ctx.ok('NOOP completed');
        return true;
    });
    let port = await listen(server);
    let client = makeClient(port, { logger });
    client.on('error', () => {});

    await client.connect();
    let response = await client.exec('NOOP', false, {});
    response.next();

    test.equal(client._unknownTagCount, strayCount, 'every stray tag is counted');

    let warnings = logger.entries.warn.filter(entry => entry.msg === 'Tagged response for an unknown tag');
    // Logged at 1, 2, 4 and 8 - the powers of two up to 10
    test.equal(warnings.length, 4, 'warning volume is bounded rather than one line per stray tag');
    test.deepEqual(
        warnings.map(entry => entry.unknownTagCount),
        [1, 2, 4, 8],
        'warnings are emitted at the first occurrence and then at powers of two'
    );

    client.close();
    server.close();
    test.done();
};

module.exports['Tag correlation: commands stay serialized'] = async test => {
    let inFlight = 0;
    let maxInFlight = 0;
    let server = createServer(ctx => {
        if (ctx.command !== 'NOOP') {
            return false;
        }
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        setTimeout(() => {
            inFlight--;
            ctx.ok('NOOP completed');
        }, 20);
        return true;
    });
    let port = await listen(server);
    let client = makeClient(port);
    client.on('error', () => {});

    await client.connect();

    // sequential
    for (let i = 0; i < 2; i++) {
        let response = await client.exec('NOOP', false, {});
        response.next();
    }

    // concurrently queued. Each caller releases its own response as soon as it settles, which
    // is the contract every command handler follows.
    await Promise.all(
        [0, 1, 2].map(async () => {
            let response = await client.exec('NOOP', false, {});
            response.next();
        })
    );

    test.equal(maxInFlight, 1, 'at most one command is active on the wire');

    client.close();
    server.close();
    test.done();
};

module.exports['Tag correlation: the next command is sent only after the previous handler returns'] = async test => {
    // Pins the completion ordering: a command handler applies its state (mailbox selection,
    // capabilities) between the tagged response and the next command reaching the wire.
    let received = [];
    let server = createServer(ctx => {
        if (ctx.command !== 'NOOP' && ctx.command !== 'CAPABILITY') {
            return false;
        }
        received.push(ctx.command);
        ctx.write(ctx.command === 'CAPABILITY' ? `* CAPABILITY ${CAPABILITIES}\r\n` : '');
        ctx.ok(`${ctx.command} completed`);
        return true;
    });
    let port = await listen(server);
    let client = makeClient(port);
    client.on('error', () => {});

    await client.connect();
    received = [];

    let first = client.exec('NOOP', false, {});
    let second = client.exec('CAPABILITY', false, {});

    let firstResponse = await first;
    test.deepEqual(received, ['NOOP'], 'the queued command is not on the wire while the handler still runs');

    firstResponse.next();
    let secondResponse = await second;
    secondResponse.next();

    test.deepEqual(received, ['NOOP', 'CAPABILITY'], 'the queued command is dispatched once the handler returned');

    client.close();
    server.close();
    test.done();
};

module.exports['Tag correlation: a response for a command that is not on the wire yet is desync'] = async test => {
    // The active command becomes `currentRequest` before it is written (compiling the command is
    // asynchronous). Tags are sequential and guessable, so a server that answers during that
    // window must not settle the command either.
    let server = createServer();
    let port = await listen(server);
    let client = makeClient(port);

    let errors = [];
    client.on('error', err => errors.push(err));

    await client.connect();

    let rejected = null;
    let request = {
        command: 'NOOP',
        attributes: [],
        options: {},
        resolve: () => test.ok(false, 'a command that was never written must not resolve'),
        reject: err => (rejected = err)
    };
    client.requestTagMap.set('A1', request);
    // current, but not marked as written
    client.currentRequest = { tag: 'A1', command: 'NOOP' };

    let served = false;
    client.streamer.read = () => {
        if (served) {
            return null;
        }
        served = true;
        return { payload: Buffer.from('A1 OK done'), literals: [], next: () => {} };
    };

    await client.reader();

    test.ok(rejected, 'the command is rejected instead of settled');
    test.equal(rejected.code, 'UnexpectedTag', 'reported as protocol desynchronization');
    test.equal(rejected.details.received, 'A1');

    client.close();
    server.close();
    test.done();
};
