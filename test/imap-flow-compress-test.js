'use strict';

// End-to-end test of the DEFLATE compression path (RFC 4978). The mock server
// negotiates COMPRESS and then speaks raw-deflate in both directions, mirroring
// the client's inflate/deflate pipeline. This covers ImapFlow.compress() and the
// compression-stream cleanup inside close().

const net = require('net');
const zlib = require('zlib');
const { ImapFlow } = require('../lib/imap-flow');

const CAPS = 'IMAP4rev1 ID ENABLE NAMESPACE COMPRESS=DEFLATE';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

// IMAP session line responder shared before and after compression.
const respond = (write, line) => {
    let parts = line.split(' ');
    let tag = parts[0];
    let cmd = (parts[1] || '').toUpperCase();
    switch (cmd) {
        case 'CAPABILITY':
            write(`* CAPABILITY ${CAPS}\r\n${tag} OK done\r\n`);
            break;
        case 'ID':
            write(`* ID ("name" "mock" "version" "1")\r\n${tag} OK done\r\n`);
            break;
        case 'LOGIN':
            write(`${tag} OK LOGIN done\r\n`);
            break;
        case 'NAMESPACE':
            write(`* NAMESPACE (("" "/")) NIL NIL\r\n${tag} OK done\r\n`);
            break;
        case 'ENABLE':
            write(`${tag} OK done\r\n`);
            break;
        case 'NOOP':
            write(`${tag} OK NOOP done\r\n`);
            break;
        case 'LOGOUT':
            write(`* BYE bye\r\n${tag} OK done\r\n`);
            break;
        default:
            write(`${tag} BAD unknown ${cmd}\r\n`);
    }
};

module.exports['Compress: session negotiates DEFLATE and runs commands'] = async test => {
    let server = net.createServer(socket => {
        socket.on('error', () => {});

        let compressed = false;
        let deflate = null;
        let inflate = null;
        let buf = '';

        // Plain writer (pre-compression)
        let writePlain = str => socket.write(str);
        // Compressed writer: deflate + flush so the client receives complete frames
        let writeDeflate = str => {
            deflate.write(Buffer.from(str, 'binary'));
            deflate.flush();
        };

        // function declarations (hoisted) because feed() and onLine() are mutually recursive
        let lineBuf = '';
        function onLine(line) {
            let parts = line.split(' ');
            let tag = parts[0];
            let cmd = (parts[1] || '').toUpperCase();
            if (cmd === 'COMPRESS') {
                // Acknowledge, then switch both directions to raw deflate
                writePlain(`${tag} OK Begin compression\r\n`);
                compressed = true;
                deflate = zlib.createDeflateRaw();
                inflate = zlib.createInflateRaw();
                deflate.pipe(socket);
                inflate.on('data', d => feed(d.toString('binary')));
                inflate.on('error', () => {});
                deflate.on('error', () => {});
                return;
            }
            respond(compressed ? writeDeflate : writePlain, line);
        }

        function feed(chunk) {
            lineBuf += chunk;
            let idx;
            while ((idx = lineBuf.indexOf('\r\n')) >= 0) {
                let line = lineBuf.slice(0, idx);
                lineBuf = lineBuf.slice(idx + 2);
                onLine(line);
            }
        }

        socket.on('data', data => {
            if (compressed) {
                // After COMPRESS negotiation, all inbound bytes are deflated
                inflate.write(data);
            } else {
                buf += data.toString('binary');
                let idx;
                while ((idx = buf.indexOf('\r\n')) >= 0) {
                    let line = buf.slice(0, idx);
                    buf = buf.slice(idx + 2);
                    // hand off any already-buffered bytes after COMPRESS to inflate
                    onLine(line);
                    if (compressed && buf.length) {
                        inflate.write(Buffer.from(buf, 'binary'));
                        buf = '';
                    }
                }
            }
        });

        socket.write(`* OK [CAPABILITY ${CAPS}] ready\r\n`);
    });

    let port = await listen(server);
    let client = new ImapFlow({
        host: '127.0.0.1',
        port,
        secure: false,
        disableAutoIdle: true,
        disableCompression: false, // enable COMPRESS negotiation
        logger: false,
        auth: { user: 'test', pass: 'secret' }
    });
    client.on('error', () => {});

    await client.connect();
    test.ok(client.usable);
    test.ok(client._deflate, 'deflate pipeline established');
    test.ok(client._inflate, 'inflate pipeline established');

    // Run a command through the compressed channel
    await client.noop();

    // Push a buffer larger than the deflate writable highWaterMark (64KB) straight
    // through the compression pump so its buffer overflows and readNext waits for 'drain'.
    client.state = client.states.AUTHENTICATED;
    client.commandParts = [];
    client.write(Buffer.alloc(128 * 1024, 0x61));
    await new Promise(r => setTimeout(r, 50));

    await client.logout();
    client.close();
    // close() must tear down the compression streams
    test.ok(!client._deflate, 'deflate cleaned up after close');
    test.ok(!client._inflate, 'inflate cleaned up after close');

    server.close();
    test.done();
};
