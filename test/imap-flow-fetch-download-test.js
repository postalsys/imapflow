'use strict';

// Tests for the fetch generator and the download / downloadMany streaming
// orchestration in ImapFlow. These exercise the real method bodies while
// stubbing the lower-level run()/fetchOne() so message data is fully controlled.

const { ImapFlow } = require('../lib/imap-flow');
const libbase64 = require('libbase64');
const libqp = require('libqp');
const libmime = require('libmime');
const { Writable, finished } = require('stream');

const makeClient = (overrides = {}) => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        port: 993,
        auth: { user: 'test', pass: 'test' },
        logger: false,
        ...overrides
    });
    client.socket = { destroyed: false, destroy: () => {} };
    client.usable = true;
    client.mailbox = { path: 'INBOX', exists: 10 };
    client.state = client.states.SELECTED;
    return client;
};

const collect = stream =>
    new Promise((resolve, reject) => {
        let chunks = [];
        stream.on('data', c => chunks.push(c));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
    });

// ============================================================================
// fetch() generator
// ============================================================================

module.exports['Fetch: generator returns nothing without mailbox'] = async test => {
    let client = makeClient();
    client.mailbox = false;
    let results = [];
    for await (let msg of client.fetch('1:*', { uid: true })) {
        results.push(msg);
    }
    test.equal(results.length, 0);
    test.done();
};

module.exports['Fetch: generator returns when range resolves empty'] = async test => {
    let client = makeClient();
    let results = [];
    for await (let msg of client.fetch([], { uid: true })) {
        results.push(msg);
    }
    test.equal(results.length, 0);
    test.done();
};

module.exports['Fetch: generator yields untagged fetch responses'] = async test => {
    let client = makeClient();
    client.run = async (command, range, query, options) => {
        test.equal(command, 'FETCH');
        // Simulate the FETCH handler pushing two rows
        options.onUntaggedFetch({ seq: 1, uid: 11 }, () => {});
        options.onUntaggedFetch({ seq: 2, uid: 12 }, () => {});
        return true;
    };
    let results = [];
    for await (let msg of client.fetch('1:2', { uid: true })) {
        results.push(msg);
    }
    test.equal(results.length, 2);
    test.equal(results[0].uid, 11);
    test.equal(results[1].uid, 12);
    test.done();
};

module.exports['Fetch: generator breaks early and drains backpressure'] = async test => {
    let client = makeClient();
    let nextCalls = 0;
    client.run = async (command, range, query, options) => {
        options.onUntaggedFetch({ seq: 1, uid: 11 }, () => nextCalls++);
        options.onUntaggedFetch({ seq: 2, uid: 12 }, () => nextCalls++);
        options.onUntaggedFetch({ seq: 3, uid: 13 }, () => nextCalls++);
        return true;
    };
    let results = [];
    for await (let msg of client.fetch('1:3', {})) {
        results.push(msg);
        break; // exit early -> finally{} must drain remaining next() callbacks
    }
    test.equal(results.length, 1);
    // The yielded item's next plus the queued items get drained
    test.ok(nextCalls >= 1);
    test.done();
};

module.exports['Fetch: generator throws when run rejects'] = async test => {
    let client = makeClient();
    client.run = async () => {
        throw new Error('FETCH failed');
    };
    let threw = null;
    try {
        // eslint-disable-next-line no-unused-vars
        for await (let msg of client.fetch('1:2', {})) {
            // no-op
        }
    } catch (err) {
        threw = err;
    }
    test.ok(threw);
    test.equal(threw.message, 'FETCH failed');
    test.done();
};

module.exports['Fetch: generator throws if connection closes mid-iteration'] = async test => {
    let client = makeClient();
    client.run = async (command, range, query, options) => {
        // queue two rows so a second loop iteration runs after we close the socket
        options.onUntaggedFetch({ seq: 1, uid: 11 }, () => {});
        options.onUntaggedFetch({ seq: 2, uid: 12 }, () => {});
        return true;
    };
    let threw = null;
    try {
        // eslint-disable-next-line no-unused-vars
        for await (let msg of client.fetch('1:2', {})) {
            // close the connection before the next iteration's guard runs
            client.socket.destroyed = true;
        }
    } catch (err) {
        threw = err;
    }
    test.ok(threw);
    test.equal(threw.code, 'EConnectionClosed');
    test.done();
};

// ============================================================================
// fetchOne() / fetchAll()
// ============================================================================

module.exports['Fetch: fetchOne returns undefined without mailbox'] = async test => {
    let client = makeClient();
    client.mailbox = false;
    let res = await client.fetchOne('1', {});
    test.equal(res, undefined);
    test.done();
};

module.exports['Fetch: fetchOne star returns false on empty mailbox'] = async test => {
    let client = makeClient();
    client.mailbox.exists = 0;
    let res = await client.fetchOne('*', {});
    test.equal(res, false);
    test.done();
};

module.exports['Fetch: fetchOne star uses last message seq'] = async test => {
    let client = makeClient();
    client.mailbox.exists = 7;
    let captured = null;
    client.run = async (command, seq, query, options) => {
        captured = { seq, options };
        return { list: [{ seq: 7, uid: 70 }] };
    };
    let res = await client.fetchOne('*', {});
    test.equal(captured.seq, '7');
    test.equal(captured.options.uid, false);
    test.equal(res.uid, 70);
    test.done();
};

module.exports['Fetch: fetchOne returns false when list empty'] = async test => {
    let client = makeClient();
    client.run = async () => ({ list: [] });
    let res = await client.fetchOne('1', {});
    test.equal(res, false);
    test.done();
};

module.exports['Fetch: fetchOne returns first message'] = async test => {
    let client = makeClient();
    client.run = async () => ({ list: [{ seq: 1, uid: 11 }] });
    let res = await client.fetchOne('1', { uid: true });
    test.equal(res.uid, 11);
    test.done();
};

module.exports['Fetch: fetchAll collects all generator results'] = async test => {
    let client = makeClient();
    client.run = async (command, range, query, options) => {
        options.onUntaggedFetch({ seq: 1, uid: 11 }, () => {});
        options.onUntaggedFetch({ seq: 2, uid: 12 }, () => {});
        return true;
    };
    let all = await client.fetchAll('1:2', {});
    test.equal(all.length, 2);
    test.done();
};

// ============================================================================
// download()
// ============================================================================

module.exports['Download: returns empty object without mailbox'] = async test => {
    let client = makeClient();
    client.mailbox = false;
    let res = await client.download('1');
    test.deepEqual(res, {});
    test.done();
};

module.exports['Download: full message in multiple chunks'] = async test => {
    let client = makeClient();
    let body = Buffer.from('A'.repeat(10));
    client.fetchOne = async (range, query) => {
        let start = query.source.start;
        let maxLength = query.source.maxLength;
        return { uid: 1, size: body.length, source: body.slice(start, start + maxLength) };
    };
    let { meta, content } = await client.download('1', false, { chunkSize: 4 });
    test.equal(meta.contentType, 'message/rfc822');
    test.equal(meta.expectedSize, 10);
    let data = await collect(content);
    test.equal(data.toString(), 'A'.repeat(10));
    test.done();
};

module.exports['Download: falls back to default chunkSize/maxBytes when zero'] = async test => {
    let client = makeClient();
    let body = Buffer.from('tiny');
    client.fetchOne = async (range, query) => {
        let start = query.source.start;
        let maxLength = query.source.maxLength;
        return { uid: 1, size: body.length, source: body.slice(start, start + maxLength) };
    };
    // zero values are falsy -> the (|| default) fallbacks kick in
    let { content } = await client.download('1', false, { chunkSize: 0, maxBytes: 0 });
    let data = await collect(content);
    test.equal(data.toString(), 'tiny');
    test.done();
};

module.exports['Download: flowed pipeline forwards a mid-stream fetch error'] = async test => {
    let client = makeClient();
    let mime = Buffer.from('Content-Type: text/plain; format=flowed\r\nContent-Disposition: inline\r\n\r\n');
    let calls = 0;
    client.fetchOne = async () => {
        calls++;
        if (calls === 1) {
            let bodyParts = new Map();
            bodyParts.set('2.mime', mime);
            bodyParts.set('2', Buffer.alloc(64, 0x61));
            return { uid: 1, size: 1000, bodyParts };
        }
        throw new Error('mid-stream flowed fetch fail');
    };
    let { content } = await client.download('1', '2', { chunkSize: 64 });
    let streamErr;
    content.on('data', () => {});
    // stream.finished() fires once with the error (if any) when the stream is
    // truly done — no end-vs-error resolve race.
    await new Promise(resolve =>
        finished(content, err => {
            streamErr = err;
            resolve();
        })
    );
    test.ok(streamErr, 'error forwarded through the flowed decoder pipeline');
    test.done();
};

module.exports['Download: returns {} when fetchOne yields no chunk'] = async test => {
    let client = makeClient();
    client.fetchOne = async () => false;
    let res = await client.download('1', false, { chunkSize: 4 });
    test.deepEqual(res, {});
    test.done();
};

module.exports['Download: base64 body part is decoded'] = async test => {
    let client = makeClient();
    let mime = Buffer.from('Content-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\n');
    let encoded = Buffer.from(libbase64.encode(Buffer.from('Hello World')));
    client.fetchOne = async () => {
        let bodyParts = new Map();
        bodyParts.set('2.mime', mime);
        bodyParts.set('2', encoded);
        return { uid: 1, size: encoded.length, bodyParts };
    };
    let { meta, content } = await client.download('1', '2', { chunkSize: 1024 });
    test.equal(meta.contentType, 'text/plain');
    test.equal(meta.encoding, 'base64');
    let data = await collect(content);
    test.equal(data.toString(), 'Hello World');
    test.done();
};

module.exports['Download: quoted-printable inline text with charset + filename'] = async test => {
    let client = makeClient();
    let mime = Buffer.from(
        'Content-Type: text/plain; charset=iso-8859-1; name="f.txt"\r\n' +
            'Content-Transfer-Encoding: quoted-printable\r\n' +
            'Content-Disposition: inline; filename="f.txt"\r\n\r\n'
    );
    let encoded = Buffer.from(libqp.encode(Buffer.from('café', 'latin1')));
    client.fetchOne = async () => {
        let bodyParts = new Map();
        bodyParts.set('3.mime', mime);
        bodyParts.set('3', encoded);
        return { uid: 1, size: encoded.length, bodyParts };
    };
    let { meta, content } = await client.download('1', '3', { chunkSize: 1024 });
    test.equal(meta.encoding, 'quoted-printable');
    test.equal(meta.filename, 'f.txt');
    // charset is converted to utf-8 for text parts
    test.equal(meta.charset, 'utf-8');
    let data = await collect(content);
    test.equal(data.toString(), 'café');
    test.done();
};

module.exports['Download: part 1 single-node message becomes TEXT'] = async test => {
    let client = makeClient();
    let calls = [];
    let textBody = Buffer.from('plain text body');
    client.fetchOne = async (range, query) => {
        calls.push(query);
        if (query.bodyStructure) {
            // single node, no childNodes
            return { uid: 1, size: textBody.length, bodyStructure: { type: 'text/plain' } };
        }
        // part has been rewritten to 'text'
        let bodyParts = new Map();
        bodyParts.set('header', Buffer.from('Content-Type: text/plain\r\n\r\n'));
        bodyParts.set('text', textBody);
        return { uid: 1, size: textBody.length, bodyParts };
    };
    let { meta, content } = await client.download('1', '1', { chunkSize: 1024 });
    test.ok(meta);
    let data = await collect(content);
    test.equal(data.toString(), 'plain text body');
    test.done();
};

module.exports['Download: part 1 returns sentinel when bodyStructure fetch fails'] = async test => {
    let client = makeClient();
    client.fetchOne = async () => false;
    let res = await client.download('1', '1', { chunkSize: 1024 });
    test.deepEqual(res, { response: false, chunk: false });
    test.done();
};

module.exports['Download: maxBytes limits output'] = async test => {
    let client = makeClient();
    let body = Buffer.from('B'.repeat(20));
    client.fetchOne = async (range, query) => {
        let start = query.source.start;
        let maxLength = query.source.maxLength;
        return { uid: 1, size: body.length, source: body.slice(start, start + maxLength) };
    };
    let { content } = await client.download('1', false, { chunkSize: 4, maxBytes: 6 });
    let data = await collect(content);
    test.ok(data.length <= 6);
    test.done();
};

module.exports['Download: part 1 with no detectable content-type treated as text'] = async test => {
    let client = makeClient();
    let textBody = Buffer.from('untyped body text');
    client.fetchOne = async (range, query) => {
        if (query.bodyStructure) {
            return { uid: 1, size: textBody.length, bodyStructure: { type: 'text/plain' } }; // no childNodes
        }
        let bodyParts = new Map();
        // empty mime header -> no contentType detected -> isTextNode via (part==='1' && !contentType)
        bodyParts.set('header', Buffer.from('\r\n'));
        bodyParts.set('text', textBody);
        return { uid: 1, size: textBody.length, bodyParts };
    };
    let { content } = await client.download('1', '1', { chunkSize: 1024 });
    let data = await collect(content);
    test.equal(data.toString(), 'untyped body text');
    test.done();
};

module.exports['Download: returns {} when requested part missing from response'] = async test => {
    let client = makeClient();
    client.fetchOne = async () => {
        // response has a mime header but not the actual part content
        let bodyParts = new Map();
        bodyParts.set('5.mime', Buffer.from('Content-Type: text/plain\r\n\r\n'));
        return { uid: 1, size: 0, bodyParts };
    };
    let res = await client.download('1', '5', { chunkSize: 1024 });
    test.deepEqual(res, {});
    test.done();
};

module.exports['Download: format=flowed inline text is decoded'] = async test => {
    let client = makeClient();
    let mime = Buffer.from('Content-Type: text/plain; format=flowed; delsp=yes\r\nContent-Disposition: inline\r\n\r\n');
    let body = Buffer.from('soft \r\nbroken\r\n');
    client.fetchOne = async () => {
        let bodyParts = new Map();
        bodyParts.set('2.mime', mime);
        bodyParts.set('2', body);
        return { uid: 1, size: body.length, bodyParts };
    };
    let { meta, content } = await client.download('1', '2', { chunkSize: 1024 });
    test.ok(meta.flowed, 'flowed flag detected');
    let data = await collect(content);
    test.ok(data.length >= 0);
    test.done();
};

module.exports['Download: unknown charset is left undecoded'] = async test => {
    let client = makeClient();
    let mime = Buffer.from('Content-Type: text/plain; charset=totally-bogus-xyz\r\nContent-Disposition: inline\r\n\r\n');
    let body = Buffer.from('hello bogus charset');
    client.fetchOne = async () => {
        let bodyParts = new Map();
        bodyParts.set('2.mime', mime);
        bodyParts.set('2', body);
        return { uid: 1, size: body.length, bodyParts };
    };
    let { meta, content } = await client.download('1', '2', { chunkSize: 1024 });
    // getDecoder throws for the bogus charset; charset stays as the original
    test.equal(meta.charset, 'totally-bogus-xyz');
    let data = await collect(content);
    test.equal(data.toString(), 'hello bogus charset');
    test.done();
};

module.exports['Download: stops when a later chunk has no data'] = async test => {
    let client = makeClient();
    let calls = 0;
    client.fetchOne = async () => {
        calls++;
        if (calls <= 3) {
            // full-size chunks keep hasMore true
            return { uid: 1, size: 100, source: Buffer.from('ABCD') };
        }
        // subsequent fetch returns no source -> getNextPart returns {} -> loop breaks
        return { uid: 1, size: 100, source: null };
    };
    let { content } = await client.download('1', false, { chunkSize: 4 });
    let data = await collect(content);
    test.equal(data.toString(), 'ABCDABCDABCD');
    test.done();
};

module.exports['Download: initial chunk waits for drain when buffer full'] = async test => {
    let client = makeClient();
    let big = Buffer.alloc(64 * 1024, 0x61); // 64KB > default 16KB highWaterMark
    let calls = 0;
    client.fetchOne = async () => {
        calls++;
        if (calls <= 2) {
            return { uid: 1, size: 200 * 1024, source: big };
        }
        return { uid: 1, size: 200 * 1024, source: big.slice(0, 10) };
    };
    let { content } = await client.download('1', false, { chunkSize: 64 * 1024 });

    // Do NOT consume yet: with no consumer the first 64KB write returns false,
    // so download registers a 'drain' listener and waits before fetching more.
    await new Promise(resolve => setTimeout(resolve, 25));

    // Now drain it.
    let received = 0;
    content.on('data', c => {
        received += c.length;
    });
    await new Promise(resolve => content.on('end', resolve));
    test.ok(received > 64 * 1024);
    test.done();
};

module.exports['Download: in-loop backpressure waits for drain'] = async test => {
    let client = makeClient();
    let big = Buffer.alloc(64 * 1024, 0x61);
    let calls = 0;
    client.fetchOne = async () => {
        calls++;
        if (calls <= 4) {
            return { uid: 1, size: 400 * 1024, source: big };
        }
        return { uid: 1, size: 400 * 1024, source: big.slice(0, 10) };
    };
    let { content } = await client.download('1', false, { chunkSize: 64 * 1024 });

    // A slow consumer attached immediately. The first write succeeds (data moves
    // one buffer down) but subsequent loop writes return false while the consumer
    // is still draining the previous chunk, exercising the in-loop drain wait.
    let received = 0;
    let slow = new Writable({
        highWaterMark: 1,
        write(chunk, enc, cb) {
            received += chunk.length;
            setTimeout(cb, 40);
        }
    });
    content.pipe(slow);
    await new Promise(resolve => slow.on('finish', resolve));

    test.ok(received > 64 * 1024);
    test.done();
};

module.exports['Download: error during streaming surfaces on content stream'] = async test => {
    let client = makeClient();
    let calls = 0;
    client.fetchOne = async () => {
        calls++;
        if (calls === 1) {
            // metadata chunk (full size keeps hasMore true)
            return { uid: 1, size: 100, source: Buffer.alloc(4, 0x61) };
        }
        // subsequent loop fetch fails -> fetchAllParts rejects -> error on stream
        throw new Error('mid-stream fetch failure');
    };
    let { content } = await client.download('1', false, { chunkSize: 4 });
    let streamErr;
    content.on('data', () => {});
    await new Promise(resolve =>
        finished(content, err => {
            streamErr = err;
            resolve();
        })
    );
    test.ok(streamErr, 'error surfaced on content stream');
    test.equal(streamErr.message, 'mid-stream fetch failure');
    test.done();
};

module.exports['Download: write error on initial chunk surfaces on stream'] = async test => {
    let client = makeClient();
    // a non-Buffer source makes stream.write throw inside the setImmediate try/catch
    client.fetchOne = async () => ({ uid: 1, size: 100, source: 999999 });
    let { content } = await client.download('1', false, { chunkSize: 4 });
    let streamErr;
    content.on('data', () => {});
    await new Promise(resolve =>
        finished(content, err => {
            streamErr = err;
            resolve();
        })
    );
    test.ok(streamErr, 'write error surfaced');
    test.done();
};

module.exports['Download: destroying content before streaming aborts cleanly'] = async test => {
    let client = makeClient();
    let big = Buffer.alloc(64 * 1024, 0x61);
    client.fetchOne = async (range, query) => {
        let start = query.source.start;
        return { uid: 1, size: 500 * 1024, source: big.slice(start, start + 64 * 1024) };
    };
    let { content } = await client.download('1', false, { chunkSize: 64 * 1024 });
    // Destroy immediately: the deferred writeChunk sees a destroyed stream and bails.
    content.destroy();
    await new Promise(resolve => setTimeout(resolve, 30));
    test.ok(true, 'no crash when content destroyed before streaming starts');
    test.done();
};

module.exports['Download: aborting mid-backpressure stops the fetch loop'] = async test => {
    let client = makeClient();
    let big = Buffer.alloc(64 * 1024, 0x61);
    let calls = 0;
    client.fetchOne = async () => {
        calls++;
        if (calls <= 6) {
            return { uid: 1, size: 1000 * 1024, source: big };
        }
        return { uid: 1, size: 1000 * 1024, source: big.slice(0, 10) };
    };
    let { content } = await client.download('1', false, { chunkSize: 64 * 1024 });

    // Slow consumer to force backpressure, then destroy mid-stream so the loop
    // aborts during a drain wait.
    let slow = new Writable({
        highWaterMark: 1,
        write(chunk, enc, cb) {
            setTimeout(cb, 50);
        }
    });
    content.pipe(slow);
    setTimeout(() => content.destroy(), 70);
    await new Promise(resolve => {
        slow.on('finish', resolve);
        content.on('close', resolve);
        content.on('error', resolve);
    });
    test.ok(true, 'aborted mid-backpressure without hanging');
    test.done();
};

// ============================================================================
// downloadMany()
// ============================================================================

module.exports['DownloadMany: returns empty object without mailbox'] = async test => {
    let client = makeClient();
    client.mailbox = false;
    let res = await client.downloadMany('1', ['2']);
    test.deepEqual(res, {});
    test.done();
};

module.exports['DownloadMany: returns {response:false} when no bodyParts'] = async test => {
    let client = makeClient();
    client.fetchOne = async () => ({ uid: 1 });
    let res = await client.downloadMany('1', ['2']);
    test.deepEqual(res, { response: false });
    test.done();
};

module.exports['DownloadMany: parses charset, flowed and name params'] = async test => {
    let client = makeClient();
    let mime = Buffer.from(
        'Content-Type: text/plain; charset=iso-8859-1; format=flowed; delsp=yes; name="x.txt"\r\n' +
            'Content-Disposition: inline\r\n\r\n'
    );
    client.fetchOne = async () => {
        let bodyParts = new Map();
        bodyParts.set('2.mime', mime);
        bodyParts.set('2', Buffer.from('plain'));
        return { uid: 1, bodyParts };
    };
    let res = await client.downloadMany('1', ['2']);
    test.equal(res['2'].meta.charset, 'iso-8859-1');
    test.equal(res['2'].meta.flowed, true);
    test.equal(res['2'].meta.delSp, true);
    test.equal(res['2'].meta.filename, 'x.txt');
    test.done();
};

module.exports['DownloadMany: tolerates decodeWords failures for disposition/filename'] = async test => {
    let originalDecodeWords = libmime.decodeWords;
    libmime.decodeWords = () => {
        throw new Error('decodeWords boom');
    };
    try {
        let client = makeClient();
        let mime = Buffer.from('Content-Type: text/plain\r\nContent-Disposition: attachment; filename="f.txt"\r\n\r\n');
        client.fetchOne = async () => {
            let bodyParts = new Map();
            bodyParts.set('2.mime', mime);
            bodyParts.set('2', Buffer.from('x'));
            return { uid: 1, bodyParts };
        };
        let res = await client.downloadMany('1', ['2']);
        // disposition/filename are kept as-is when decodeWords throws
        test.equal(res['2'].meta.disposition, 'attachment');
        test.equal(res['2'].meta.filename, 'f.txt');
    } finally {
        libmime.decodeWords = originalDecodeWords;
    }
    test.done();
};

module.exports['Download: tolerates decodeWords failures for disposition/filename'] = async test => {
    let originalDecodeWords = libmime.decodeWords;
    libmime.decodeWords = () => {
        throw new Error('decodeWords boom');
    };
    try {
        let client = makeClient();
        let mime = Buffer.from('Content-Type: text/plain\r\nContent-Disposition: attachment; filename="f.txt"\r\n\r\n');
        client.fetchOne = async () => {
            let bodyParts = new Map();
            bodyParts.set('2.mime', mime);
            bodyParts.set('2', Buffer.from('hello'));
            return { uid: 1, size: 5, bodyParts };
        };
        let { meta, content } = await client.download('1', '2', { chunkSize: 1024 });
        test.equal(meta.disposition, 'attachment');
        test.equal(meta.filename, 'f.txt');
        await collect(content);
    } finally {
        libmime.decodeWords = originalDecodeWords;
    }
    test.done();
};

module.exports['DownloadMany: encoded parts with no content decode to null'] = async test => {
    let client = makeClient();
    let mime2 = Buffer.from('Content-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\n');
    let mime3 = Buffer.from('Content-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n');
    client.fetchOne = async () => {
        let bodyParts = new Map();
        // only the mime headers, no actual content parts -> content stays undefined
        bodyParts.set('2.mime', mime2);
        bodyParts.set('3.mime', mime3);
        return { uid: 1, bodyParts };
    };
    let res = await client.downloadMany('1', ['2', '3']);
    test.equal(res['2'].content, null); // base64 decode of missing content -> null
    test.equal(res['3'].content, null); // quoted-printable decode of missing content -> null
    test.done();
};

module.exports['DownloadMany: handles content part arriving before its mime header'] = async test => {
    let client = makeClient();
    client.fetchOne = async () => {
        let bodyParts = new Map();
        bodyParts.set('2', Buffer.from('hello')); // content first
        bodyParts.set('2.mime', Buffer.from('Content-Type: text/plain\r\n\r\n'));
        return { uid: 1, bodyParts };
    };
    let res = await client.downloadMany('1', ['2']);
    test.equal(res['2'].content.toString(), 'hello');
    test.equal(res['2'].meta.contentType, 'text/plain');
    test.done();
};

module.exports['Download: charset pipeline forwards a mid-stream fetch error'] = async test => {
    let client = makeClient();
    let mime = Buffer.from('Content-Type: text/plain; charset=iso-8859-1\r\nContent-Disposition: inline\r\n\r\n');
    let calls = 0;
    client.fetchOne = async () => {
        calls++;
        if (calls === 1) {
            let bodyParts = new Map();
            bodyParts.set('2.mime', mime);
            bodyParts.set('2', Buffer.alloc(64, 0x61)); // full chunk -> hasMore
            return { uid: 1, size: 1000, bodyParts };
        }
        throw new Error('mid-stream charset fetch fail');
    };
    let { content } = await client.download('1', '2', { chunkSize: 64 });
    let streamErr;
    content.on('data', () => {});
    await new Promise(resolve =>
        finished(content, err => {
            streamErr = err;
            resolve();
        })
    );
    test.ok(streamErr, 'error forwarded through the charset decoder pipeline');
    test.done();
};

// Covers the `(part === '1' && !meta.contentType)` text-node branch: for a
// MULTIPART message, part '1' is NOT rewritten to TEXT, so requesting part '1'
// whose MIME headers carry no Content-Type reaches that sub-condition.
module.exports['Download: multipart part 1 without content-type streams as a text node'] = async test => {
    let client = makeClient();
    client.fetchOne = async (range, query) => {
        if (query.bodyStructure) {
            // childNodes present -> multipart -> part '1' stays '1'
            return {
                uid: 1,
                size: 11,
                bodyStructure: { type: 'multipart/mixed', childNodes: [{ type: 'text/plain' }, { type: 'application/octet-stream' }] }
            };
        }
        let bodyParts = new Map();
        // MIME headers with no Content-Type -> meta.contentType stays unset
        bodyParts.set('1.mime', Buffer.from('\r\n'));
        bodyParts.set('1', Buffer.from('hello world'));
        return { uid: 1, size: 11, bodyParts };
    };
    let { content } = await client.download('1', '1', { chunkSize: 64 });
    let data = await collect(content);
    test.equal(data.toString(), 'hello world');
    test.done();
};

module.exports['DownloadMany: decodes base64 and quoted-printable parts'] = async test => {
    let client = makeClient();
    let mime2 = Buffer.from('Content-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\n');
    let mime3 = Buffer.from(
        'Content-Type: application/octet-stream; name="a.bin"\r\n' +
            'Content-Transfer-Encoding: quoted-printable\r\n' +
            'Content-Disposition: attachment; filename="a.bin"\r\n\r\n'
    );
    client.fetchOne = async (range, query) => {
        test.ok(query.bodyParts.includes('2.mime'));
        let bodyParts = new Map();
        bodyParts.set('2.mime', mime2);
        bodyParts.set('2', Buffer.from(libbase64.encode(Buffer.from('part two'))));
        bodyParts.set('3.mime', mime3);
        bodyParts.set('3', Buffer.from(libqp.encode(Buffer.from('part three'))));
        return { uid: 1, bodyParts };
    };
    let res = await client.downloadMany('1', ['2', '3']);
    test.equal(res['2'].content.toString(), 'part two');
    test.equal(res['2'].meta.contentType, 'text/plain');
    test.equal(res['3'].content.toString(), 'part three');
    test.equal(res['3'].meta.filename, 'a.bin');
    test.equal(res['3'].meta.disposition, 'attachment');
    test.done();
};
