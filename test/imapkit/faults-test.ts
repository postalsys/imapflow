import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rfc822, startImapKit } from '../fixtures/imapkit.js';

// Servers that misbehave on purpose, through ImapKit script rules: canned or dropped responses,
// output cut short, split or delayed, unsolicited responses in odd places and dropped connections.
// The server state stays consistent under a fault, so what is checked is how the client copes.

const PLUGINS = ['IDLE', 'UIDPLUS', 'MOVE', 'ENABLE', 'CONDSTORE', 'SPECIAL-USE', 'LITERALPLUS'];

// A message with a text part large enough for a download of several chunks
const LONG_TEXT = Array.from({ length: 2000 }, (_, i) => `line ${i} of the long text part`).join('\r\n');
const MULTIPART =
    'From: a@example.com\r\nSubject: long\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n' +
    '--b\r\nContent-Type: text/plain\r\n\r\nfirst\r\n' +
    `--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${LONG_TEXT}\r\n--b--\r\n`;
const STORAGE = { INBOX: { messages: [{ raw: MULTIPART }, { raw: rfc822('second') }] } };

// A server with the messages above and the given script rules
const start = (t: any, script: any, { plugins = PLUGINS, allowBad = false } = {}) =>
    startImapKit(t, { allowBad, server: { plugins, storage: STORAGE, script } });

const read = async (content: any) => Buffer.concat(await content.toArray()).toString();

// once(client, 'close') would reject on the 'error' event that comes before the close
const closed = (client: any) => new Promise(resolve => client.once('close', resolve));

describe('imapkit faults: greeting and session setup', () => {
    it('a BYE greeting rejects connect()', async t => {
        const kit = await start(t, { on: 'greeting', send: '* BYE Too many connections\r\n', close: true });
        await assert.rejects(kit.connect(), (err: any) => {
            assert.equal(err.reason, 'Too many connections');
            return true;
        });
    });

    it('a greeting that never comes times out', async t => {
        const kit = await start(t, { on: 'greeting', drop: true });
        await assert.rejects(kit.connect({ greetingTimeout: 200 }), (err: any) => {
            assert.equal(err.code, 'GREETING_TIMEOUT');
            return true;
        });
    });

    it('a greeting split into single octets is read', async t => {
        const kit = await start(t, { on: 'greeting', send: '* OK [CAPABILITY IMAP4rev1 IDLE] split greeting\r\n', chunk: 1, chunkDelay: 1 });
        const client = await kit.connect();
        assert.ok(client.usable);
        await client.logout();
    });

    it('BAD for ID and ENABLE does not stop the session', async t => {
        const kit = await start(
            t,
            [
                { on: 'command', command: 'ID', send: '$TAG BAD ID not today\r\n' },
                { on: 'command', command: 'ENABLE', send: '$TAG BAD ENABLE not today\r\n' }
            ],
            { plugins: [...PLUGINS, 'ID'], allowBad: true }
        );
        const client = await kit.connect();
        assert.equal(client.enabled.size, 0);
        await client.mailboxOpen('INBOX');
        await client.logout();
    });

    it('LOGIN refused with UNAVAILABLE rejects connect() with the response code', async t => {
        const kit = await start(t, { on: 'command', command: 'LOGIN', send: '$TAG NO [UNAVAILABLE] Backend down\r\n' });
        await assert.rejects(kit.connect(), (err: any) => {
            assert.equal(err.serverResponseCode, 'UNAVAILABLE');
            return true;
        });
    });
});

describe('imapkit faults: commands', () => {
    it('a SELECT refused once can be retried', async t => {
        const kit = await start(t, { on: 'command', command: 'SELECT', times: 1, send: '$TAG NO [UNAVAILABLE] Try again later\r\n' });
        const client = await kit.connect();
        await assert.rejects(client.mailboxOpen('INBOX'), (err: any) => {
            assert.equal(err.serverResponseCode, 'UNAVAILABLE');
            return true;
        });
        const mailbox = await client.mailboxOpen('INBOX');
        assert.equal(mailbox.exists, 2);
        await client.logout();
    });

    it('a throttled FETCH is retried after the suggested back-off (Microsoft 365)', async t => {
        const kit = await start(
            t,
            { on: 'command', command: 'FETCH', times: 1, send: '$TAG BAD Request is throttled. Suggested Backoff Time: 50 milliseconds\r\n' },
            { allowBad: true }
        );
        const client = await kit.connect();
        // the back-off is real time, only the waits are recorded
        const waits = t.mock.method(client, 'throttleWait', async () => false);
        await client.mailboxOpen('INBOX');
        const messages = await client.fetchAll('1:*', { envelope: true });
        assert.deepEqual(
            messages.map((message: any) => message.envelope.subject),
            ['long', 'second']
        );
        assert.equal(kit.script.rules[0]!.hits, 1);
        assert.ok(waits.mock.calls.length > 0, 'the retry waited out a back-off');
        await client.logout();
    });

    it('a command that is never answered fails with a socket timeout', async t => {
        const kit = await start(t, { on: 'command', command: 'FETCH', drop: true });
        const client = await kit.connect({ socketTimeout: 300 });
        await client.mailboxOpen('INBOX');
        const closing = closed(client);
        const errors: any[] = [];
        client.on('error', (err: any) => errors.push(err));
        // the command fails as any command of a lost connection, the reason comes with the error event
        await assert.rejects(client.fetchAll('1:*', { flags: true }), (err: any) => {
            assert.equal(err.code, 'NoConnection');
            return true;
        });
        await closing;
        assert.deepEqual(
            errors.map(err => err.code),
            ['ETIMEOUT']
        );
    });

    it('an unsolicited BYE before the tagged answer fails the command and ends the session', async t => {
        const kit = await start(t, { on: 'command', command: 'STATUS', send: '* BYE Server shutting down\r\n', close: true });
        const client = await kit.connect();
        // status() reports a failed command as false
        assert.equal(await client.status('INBOX', { messages: true }), false);
        assert.equal(client.usable, false);
        await assert.rejects(client.noop(), (err: any) => {
            assert.equal(err.code, 'NoConnection');
            return true;
        });
    });
});

describe('imapkit faults: FETCH responses', () => {
    it(
        'every string sent as a literal where the grammar allows one is parsed the same',
        { skip: 'needs the literals option of script rules, postalsys/imapkit#79' },
        async t => {
            // valid IMAP a client must handle: Yahoo sends long or 8-bit values as literals
            const kit = await start(t, { on: 'response', untagged: true, literals: true }, { plugins: [...PLUGINS, 'NAMESPACE'] });
            const client = await kit.connect();
            assert.equal(client.namespace.delimiter, '/');
            const folders = await client.list();
            assert.ok(folders.some((folder: any) => folder.path === 'INBOX' && folder.delimiter === '/'));
            await client.mailboxOpen('INBOX');
            const message = await client.fetchOne('1', { envelope: true, bodyStructure: true, flags: true });
            assert.equal(message.envelope.subject, 'long');
            assert.equal(message.envelope.from[0].address, 'a@example.com');
            assert.equal(message.bodyStructure.childNodes.length, 2);
            await client.logout();
        }
    );

    it('a FETCH answer written one octet at a time is read', async t => {
        const kit = await start(t, { on: 'response', command: 'FETCH', untagged: true, chunk: 1, chunkDelay: 0 });
        const client = await kit.connect();
        await client.mailboxOpen('INBOX');
        const message = await client.fetchOne('1', { source: true });
        assert.equal(message.source.toString(), MULTIPART);
        await client.logout();
    });

    it('a FETCH cut short in the middle of a literal rejects instead of returning partial data', async t => {
        const kit = await start(t, { on: 'response', command: 'FETCH', untagged: true, match: /BODY\[\]/, truncate: 200 });
        const client = await kit.connect();
        await client.mailboxOpen('INBOX');
        const closing = closed(client);
        await assert.rejects(client.fetchOne('1', { source: true }));
        await closing;
    });

    it('a download cut short mid-chunk ends the stream with an error, not a clean end', async t => {
        // the third chunk of the part is cut short and the connection closed
        const kit = await start(t, { on: 'response', command: 'UID FETCH', untagged: true, match: /BODY\[2\]<2000>/, truncate: 500 });
        const client = await kit.connect();
        await client.mailboxOpen('INBOX');
        const { content } = await client.download('1', '2', { chunkSize: 1000 });
        await assert.rejects(read(content));
    });

    it('a flag change of another message inside the FETCH answer does not end a download (issue #426)', async t => {
        const kit = await start(t, {
            on: 'response',
            command: 'UID FETCH',
            untagged: true,
            match: /BODY\[2\]<\d*[1-9]\d*>/,
            before: '* 2 FETCH (FLAGS (\\Seen))\r\n'
        });
        const client = await kit.connect();
        await client.mailboxOpen('INBOX');
        const { content } = await client.download('1', '2', { chunkSize: 4000 });
        assert.equal((await read(content)).trim(), LONG_TEXT);
        assert.ok(kit.script.rules[0]!.hits > 1);
        await client.logout();
    });

    it(
        'a FETCH answer written after the tagged OK never ends a download silently (Apache James)',
        { skip: 'needs the defer action of script rules, postalsys/imapkit#78' },
        async t => {
            // James now and then writes a FETCH answer after the tagged OK, so it shows up within
            // the answer to the next chunk. The download has to come out whole or fail, a quiet
            // early end would pass a truncated part off as complete.
            const kit = await start(t, { on: 'response', command: 'UID FETCH', untagged: true, match: /BODY\[2\]<4000>/, times: 1, defer: 'tagged' });
            const client = await kit.connect();
            await client.mailboxOpen('INBOX');
            const { content } = await client.download('1', '2', { chunkSize: 4000 });
            const text = await read(content).catch((err: any) => {
                assert.equal(err.code, 'DownloadIncomplete');
                return false;
            });
            if (typeof text === 'string') {
                assert.equal(text.trim(), LONG_TEXT);
            }
            await client.logout();
        }
    );
});

describe('imapkit faults: connection loss', () => {
    for (const close of [true, 'reset'] as const) {
        it(
            `a connection ${close === 'reset' ? 'reset' : 'closed'} during IDLE emits close and settles idle()`,
            { skip: close === 'reset' ? 'the reset does not reach the client after a longer session, postalsys/imapkit#81' : false },
            async t => {
                const kit = await start(t, { on: 'continuation', description: 'IDLE', close });
                const client = await kit.connect();
                await client.mailboxOpen('INBOX');
                const started = Date.now();
                const closing = closed(client);
                await client.idle().catch(() => false);
                await closing;
                assert.equal(client.usable, false);
                assert.ok(Date.now() - started < 1000, 'noticed right away, not through keepalive');
            }
        );
    }

    it('a STARTTLS that the server acknowledges and then drops fails as a TLS failure', async t => {
        const kit = await start(t, { on: 'response', command: 'STARTTLS', untagged: false, close: 'reset' }, { plugins: [...PLUGINS, 'STARTTLS'] });
        await assert.rejects(kit.connect(), (err: any) => {
            assert.equal(err.tlsFailed, true);
            return true;
        });
    });
});
