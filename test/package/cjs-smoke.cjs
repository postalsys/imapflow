'use strict';

// CommonJS smoke test for the built package, run by `npm run test:cjs` as plain Node with
// NODE_OPTIONS=--no-experimental-require-module. EmailEngine bundles ImapFlow into a
// @yao-pkg/pkg binary that can only load a CommonJS module graph, and Node 22+ enables
// require(esm) by default, which would hide an ES-module-only dependency. With the flag set,
// any ES module reached through require() throws ERR_REQUIRE_ESM here instead of in the binary.
// Kept as plain JavaScript on purpose: running it through tsx would let its loader transpile an
// ES module dependency to CommonJS and mask exactly the failure this guards against.

const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const pkg = require(path.join(root, 'package.json'));
const entry = path.join(root, pkg.exports['.'].require);

async function run() {
    const imapflow = require(entry);
    assert.strictEqual(typeof imapflow.ImapFlow, 'function');
    assert.strictEqual(typeof imapflow.AuthenticationFailure, 'function');
    assert.strictEqual(typeof imapflow.createStreamsTransport, 'function');

    // Deep imports resolve through the same exports map as the root entry
    for (const name of ['imap-commands', 'tools', 'handler/imap-handler', 'search-compiler', 'charsets', 'jp-decoder', 'logger']) {
        require('imapflow/lib/' + name);
    }

    // The default logger is pino; build it so the whole logging path is loaded too
    const { getDefaultLogger } = require('imapflow/lib/logger');
    assert.strictEqual(typeof getDefaultLogger().child, 'function');

    // A short session against an in-process server exercises the parser, the compiler, the
    // command modules and the charset and MIME dependencies reached through them
    const server = net.createServer(socket => {
        let buffer = '';
        socket.write('* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] ready\r\n');
        socket.on('data', chunk => {
            buffer += chunk.toString('binary');
            let pos;
            while ((pos = buffer.indexOf('\r\n')) >= 0) {
                const line = buffer.slice(0, pos);
                buffer = buffer.slice(pos + 2);
                const [tag, command] = line.split(' ');
                switch ((command || '').toUpperCase()) {
                    case 'CAPABILITY':
                        socket.write('* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n' + tag + ' OK done\r\n');
                        break;
                    case 'LOGIN':
                        socket.write(tag + ' OK [CAPABILITY IMAP4rev1] logged in\r\n');
                        break;
                    case 'LIST':
                        if (line.endsWith(' "" ""')) {
                            // Delimiter discovery
                            socket.write('* LIST (\\Noselect) "/" ""\r\n' + tag + ' OK done\r\n');
                            break;
                        }
                        socket.write('* LIST (\\HasNoChildren) "/" INBOX\r\n* LIST (\\HasNoChildren) "/" "&ANw-bung"\r\n' + tag + ' OK done\r\n');
                        break;
                    case 'LSUB':
                        socket.write('* LSUB () "/" INBOX\r\n' + tag + ' OK done\r\n');
                        break;
                    case 'SELECT':
                        socket.write(
                            '* 1 EXISTS\r\n* FLAGS (\\Seen)\r\n* OK [UIDVALIDITY 7] ok\r\n* OK [UIDNEXT 2] ok\r\n' + tag + ' OK [READ-WRITE] selected\r\n'
                        );
                        break;
                    case 'LOGOUT':
                        socket.end('* BYE bye\r\n' + tag + ' OK done\r\n');
                        break;
                    default:
                        socket.write(tag + ' OK done\r\n');
                }
            }
        });
        socket.on('error', () => false);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

    try {
        const client = new imapflow.ImapFlow({
            host: '127.0.0.1',
            port: server.address().port,
            secure: false,
            doSTARTTLS: false,
            logger: false,
            auth: { user: 'test', pass: 'secret' }
        });
        await client.connect();
        const list = await client.list();
        assert.deepStrictEqual(list.map(entry => entry.path).sort(), ['INBOX', 'Übung']);
        const mailbox = await client.mailboxOpen('INBOX');
        assert.strictEqual(mailbox.exists, 1);
        assert.strictEqual(Number(mailbox.uidValidity), 7);
        await client.logout();
    } finally {
        server.close();
    }

    console.log('CommonJS smoke test passed (' + process.version + ', ' + (process.env.NODE_OPTIONS || 'no NODE_OPTIONS') + ')');
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
