import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ImapFlow } from '../src/imap-flow.js';

// Tagged response correlation: a tagged response may only complete the command that was
// actually written to the socket. A response for a queued-but-unsent command is proof of
// desynchronization and fails the connection closed; a wholly unknown tag is recorded but
// tolerated, because non-conforming servers do emit stray tagged lines.

const CAPABILITIES = 'IMAP4rev1 ID ENABLE NAMESPACE';

// Minimal scriptable IMAP server. `onCommand(ctx)` may fully handle a command by returning
// true; otherwise the default happy-path session responses are used.
const createServer = (onCommand: any) =>
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
                    write: (str: any) => socket.write(str),
                    ok: (text: any) => socket.write(`${parts[0]} OK ${text || 'completed'}\r\n`)
                };

                if (onCommand && onCommand(ctx)) {
                    continue;
                }

                switch (ctx.command) {
                    case 'CAPABILITY':
                        ctx.write(`* CAPABILITY ${CAPABILITIES}\r\n`);
                        (ctx.ok as any)();
                        break;
                    case 'NAMESPACE':
                        ctx.write('* NAMESPACE (("" "/")) NIL NIL\r\n');
                        (ctx.ok as any)();
                        break;
                    case 'ID':
                        ctx.write('* ID ("name" "mock")\r\n');
                        (ctx.ok as any)();
                        break;
                    default:
                        (ctx.ok as any)();
                }
            }
        });
    });

const listen = (server: any) => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

// Captures warn/error entries so bounded logging can be asserted.
const createLogger = () => {
    const entries: any[] = { warn: [], error: [] } as any;
    const noop = () => {};
    return {
        trace: noop,
        debug: noop,
        info: noop,
        warn: (entry: any) => (entries as any).warn.push(entry),
        error: (entry: any) => (entries as any).error.push(entry),
        fatal: noop,
        entries
    };
};

const makeClient = (port: any, overrides = {}) =>
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
const nextTag = (tag: any) => (parseInt(tag, 16) + 1).toString(16).toUpperCase();

describe('tag-correlation', () => {
    it('Tag correlation: response for a queued but unsent command closes the connection', async () => {
        let server = createServer((ctx: any) => {
            if (ctx.command !== 'NOOP') {
                return false;
            }
            // Answer with the tag of the command still sitting in the queue
            ctx.write(`${nextTag(ctx.tag)} OK forged completion\r\n`);
            return true;
        });
        let port = await listen(server);
        let client = makeClient(port);

        let errors: any = [];
        client.on('error', err => errors.push(err));

        await client.connect();

        let first = client.exec('NOOP', false, {});
        let second = client.exec('NOOP', false, {});

        let firstErr = await first.then(() => null).catch(err => err);
        let secondErr = await second.then(() => null).catch(err => err);

        assert.ok(secondErr, 'the queued command did not resolve from a response it never asked for');
        assert.equal(secondErr.code, 'UnexpectedTag', 'the queued command rejects with the protocol error');
        assert.ok(secondErr.details.received, 'the received tag is recorded');
        assert.equal(secondErr.details.received, nextTag(secondErr.details.expected), 'the received tag is the queued (unsent) tag');

        assert.ok(firstErr, 'the in-flight command also rejects rather than hanging');
        assert.ok(['UnexpectedTag', 'NoConnection'].includes(firstErr.code), `in-flight command rejected with ${firstErr.code}`);

        assert.ok(
            errors.some((err: any) => err.code === 'UnexpectedTag'),
            'the desynchronization is reported to the caller'
        );
        assert.ok(!client.usable, 'the connection is no longer usable');

        client.close();
        server.close();
    });
    it('Tag correlation: unknown tag is counted and survived', async () => {
        let logger: any = createLogger();
        let server = createServer((ctx: any) => {
            if (ctx.command !== 'NOOP') {
                return false;
            }
            ctx.write('ZZZZ OK stray response\r\n');
            ctx.ok('NOOP completed');
            return true;
        });
        let port = await listen(server);
        let client = makeClient(port, { logger });

        let errors: any = [];
        client.on('error', err => errors.push(err));

        await client.connect();
        assert.equal(client._unknownTagCount, 0, 'a normal session issues no unknown tags');

        let response = await client.exec('NOOP', false, {});
        response.next();

        assert.equal(client._unknownTagCount, 1, 'the stray tagged line is counted');
        assert.ok(client.usable, 'the connection survives a stray tagged line');
        assert.deepEqual(errors, [], 'no error is emitted for a merely unknown tag');
        assert.ok(
            logger.entries.warn.some((entry: any) => (entry as any).msg === 'Tagged response for an unknown tag' && (entry as any).tag === 'ZZZZ'),
            'the stray tag is logged at warn level'
        );

        await client.logout();
        client.close();
        server.close();
    });
    it('Tag correlation: unknown tag warnings are bounded but the count stays exact', async () => {
        const strayCount = 10;
        let logger: any = createLogger();
        let server = createServer((ctx: any) => {
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

        assert.equal(client._unknownTagCount, strayCount, 'every stray tag is counted');

        let warnings = logger.entries.warn.filter((entry: any) => (entry as any).msg === 'Tagged response for an unknown tag');
        // Logged at 1, 2, 4 and 8 - the powers of two up to 10
        assert.equal(warnings.length, 4, 'warning volume is bounded rather than one line per stray tag');
        assert.deepEqual(
            warnings.map((entry: any) => (entry as any).unknownTagCount),
            [1, 2, 4, 8],
            'warnings are emitted at the first occurrence and then at powers of two'
        );

        client.close();
        server.close();
    });
    it('Tag correlation: commands stay serialized', async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        let server = createServer((ctx: any) => {
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

        assert.equal(maxInFlight, 1, 'at most one command is active on the wire');

        client.close();
        server.close();
    });
    it('Tag correlation: the next command is sent only after the previous handler returns', async () => {
        // Pins the completion ordering: a command handler applies its state (mailbox selection,
        // capabilities) between the tagged response and the next command reaching the wire.
        let received: any = [];
        let server = createServer((ctx: any) => {
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
        assert.deepEqual(received, ['NOOP'], 'the queued command is not on the wire while the handler still runs');

        firstResponse.next();
        let secondResponse = await second;
        secondResponse.next();

        assert.deepEqual(received, ['NOOP', 'CAPABILITY'], 'the queued command is dispatched once the handler returned');

        client.close();
        server.close();
    });
    it('Tag correlation: a response for a command that is not on the wire yet is desync', async () => {
        // The active command becomes `currentRequest` before it is written (compiling the command is
        // asynchronous). Tags are sequential and guessable, so a server that answers during that
        // window must not settle the command either.
        let server = (createServer as any)();
        let port = await listen(server);
        let client = makeClient(port);

        let errors = [];
        client.on('error', (err: any) => errors.push(err));

        await client.connect();

        let rejected: any = null;
        let request = {
            command: 'NOOP',
            attributes: [],
            options: {},
            resolve: () => assert.ok(false, 'a command that was never written must not resolve'),
            reject: (err: any) => (rejected = err)
        };
        client.requestTagMap.set('A1', request);
        // current, but not marked as written
        client.currentRequest = { tag: 'A1', command: 'NOOP' } as any;

        let served = false;
        client.streamer.read = () => {
            if (served) {
                return null;
            }
            served = true;
            return { payload: Buffer.from('A1 OK done'), literals: [], next: () => {} };
        };

        await client.reader();

        assert.ok(rejected, 'the command is rejected instead of settled');
        assert.equal(rejected.code, 'UnexpectedTag', 'reported as protocol desynchronization');
        assert.equal((rejected as any).details.received, 'A1');

        client.close();
        server.close();
    });
});
