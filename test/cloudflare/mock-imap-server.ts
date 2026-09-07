// A small in-process IMAP server for the Workers harness. It speaks just enough IMAP4rev1
// for a session ImapFlow runs from a Worker: greeting, CAPABILITY, ID, NAMESPACE, LOGIN,
// LIST, ENABLE, SELECT, STATUS, APPEND (synchronizing and LITERAL+ literals), FETCH, SEARCH,
// NOOP and LOGOUT, plus STARTTLS (with the self-signed test certificate) and COMPRESS=DEFLATE
// when enabled. Messages appended to INBOX are kept for the lifetime of the server. It
// listens on the loopback interface only.

import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { cert, key } from '../fixtures/test-tls.js';

export interface MockMessage {
    uid: number;
    flags: string[];
    source: Buffer;
}

export interface MockImapServerOptions {
    /** Accept connections over TLS instead of cleartext */
    secure?: boolean | undefined;
    /** Advertise STARTTLS and upgrade the connection on request */
    starttls?: boolean | undefined;
    /** Advertise COMPRESS=DEFLATE and switch to DEFLATE framing on request */
    compress?: boolean | undefined;
    /** Extra capability tokens to advertise */
    capabilities?: string[] | undefined;
    /** Accepted credentials, defaults to user/pass */
    auth?: { user: string; pass: string } | undefined;
}

export interface MockImapServer {
    port: number;
    host: string;
    messages: MockMessage[];
    /** Every command line the server received, tag stripped */
    commands: string[];
    close(): Promise<void>;
}

const quote = (value: string): string => '"' + value.replace(/["\\]/g, c => '\\' + c) + '"';

const headerValue = (source: Buffer, name: string): string | null => {
    const text = source.toString('binary').split(/\r?\n\r?\n/)[0] || '';
    const match = text.match(new RegExp('^' + name + ':\\s*(.*)$', 'im'));
    return match ? match[1]!.trim() : null;
};

// Turns a sequence set into the list of messages it selects, by sequence number or UID
const selectMessages = (messages: MockMessage[], set: string, byUid: boolean): Array<{ seq: number; message: MockMessage }> => {
    const entries = messages.map((message, i) => ({ seq: i + 1, message }));
    const max = byUid ? Math.max(0, ...messages.map(m => m.uid)) : entries.length;
    const selected = new Set<number>();
    for (const part of set.split(',')) {
        const [from, to] = part.split(':');
        const start = from === '*' ? max : Number(from);
        const end = to === undefined ? start : to === '*' ? max : Number(to);
        for (let i = Math.min(start, end); i <= Math.max(start, end); i++) {
            selected.add(i);
        }
    }
    return entries.filter(entry => selected.has(byUid ? entry.message.uid : entry.seq));
};

const envelope = (message: MockMessage): string => {
    const subject = headerValue(message.source, 'Subject');
    const date = headerValue(message.source, 'Date');
    const address = (value: string | null): string => {
        const match = value && value.match(/<?([^<>\s@]+)@([^<>\s]+)>?/);
        return match ? `((NIL NIL ${quote(match[1]!)} ${quote(match[2]!)}))` : 'NIL';
    };
    const from = address(headerValue(message.source, 'From'));
    const to = address(headerValue(message.source, 'To'));
    const messageId = headerValue(message.source, 'Message-ID');
    return `(${date ? quote(date) : 'NIL'} ${subject ? quote(subject) : 'NIL'} ${from} ${from} ${from} ${to} NIL NIL NIL ${messageId ? quote(messageId) : 'NIL'})`;
};

export const startMockImapServer = (options?: MockImapServerOptions | undefined): Promise<MockImapServer> => {
    const opts = options || {};
    const auth = opts.auth || { user: 'user', pass: 'pass' };
    const messages: MockMessage[] = [];
    const commands: string[] = [];
    let uidCounter = 100;
    const uidValidity = 20260907;

    const capabilityList = (secure: boolean): string[] =>
        ['IMAP4rev1', 'ID', 'ENABLE', 'NAMESPACE', 'UIDPLUS', 'LITERAL+', 'IDLE']
            .concat(opts.starttls && !secure ? ['STARTTLS'] : [])
            .concat(opts.compress ? ['COMPRESS=DEFLATE'] : [])
            .concat(opts.capabilities || []);

    const handleConnection = (initialSocket: net.Socket) => {
        // The transport carrying the session: replaced by a TLS socket after STARTTLS, and
        // wrapped in DEFLATE streams after COMPRESS
        let socket: net.Socket = initialSocket;
        let secure = opts.secure || false;
        let compressed = false;
        let deflate: zlib.DeflateRaw | null = null;
        let buffer = Buffer.alloc(0);
        let selected = false;
        // APPEND in progress: bytes of the literal still expected, and the command tag
        let pending: { tag: string; flags: string[]; remaining: number; chunks: Buffer[] } | null = null;
        // IDLE in progress: the command tag, answered when DONE arrives
        let idling: { tag: string; timer: NodeJS.Timeout } | null = null;

        socket.setNoDelay(true);
        socket.on('error', () => {});

        const send = (data: Buffer | string) => {
            if (deflate) {
                deflate.write(data);
                deflate.flush();
            } else {
                socket.write(data);
            }
        };
        const write = (line: string) => send(line + '\r\n');

        const handleLine = (line: string) => {
            if (idling) {
                // The only line the client may send while idling is DONE
                commands.push(line);
                clearTimeout(idling.timer);
                write(`${idling.tag} OK IDLE terminated`);
                idling = null;
                return;
            }
            const parts = line.split(' ');
            const tag = parts.shift() as string;
            let command = (parts.shift() || '').toUpperCase();
            let byUid = false;
            if (command === 'UID') {
                byUid = true;
                command = (parts.shift() || '').toUpperCase();
            }
            commands.push((byUid ? 'UID ' : '') + command + (parts.length ? ' ' + parts.join(' ') : ''));

            switch (command) {
                case 'CAPABILITY':
                    write(`* CAPABILITY ${capabilityList(secure).join(' ')}`);
                    write(`${tag} OK CAPABILITY completed`);
                    break;
                case 'ID':
                    write('* ID ("name" "imapflow-mock" "version" "1")');
                    write(`${tag} OK ID completed`);
                    break;
                case 'NAMESPACE':
                    write('* NAMESPACE (("" "/")) NIL NIL');
                    write(`${tag} OK NAMESPACE completed`);
                    break;
                case 'STARTTLS': {
                    if (!opts.starttls || secure) {
                        write(`${tag} BAD STARTTLS not available`);
                        break;
                    }
                    write(`${tag} OK Begin TLS negotiation now`);
                    const plain = socket;
                    plain.removeAllListeners('data');
                    const upgraded = new tls.TLSSocket(plain, { isServer: true, cert, key });
                    upgraded.on('error', () => {});
                    upgraded.on('data', onData);
                    socket = upgraded;
                    secure = true;
                    break;
                }
                case 'LOGIN': {
                    const user = (parts[0] || '').replace(/^"|"$/g, '');
                    const pass = (parts[1] || '').replace(/^"|"$/g, '');
                    if (user === auth.user && pass === auth.pass) {
                        write(`${tag} OK [CAPABILITY ${capabilityList(secure).join(' ')}] LOGIN completed`);
                    } else {
                        write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
                    }
                    break;
                }
                case 'COMPRESS': {
                    if (!opts.compress || compressed) {
                        write(`${tag} NO COMPRESS not available`);
                        break;
                    }
                    write(`${tag} OK DEFLATE active`);
                    compressed = true;
                    // From here on both directions carry raw DEFLATE data
                    const inflate = zlib.createInflateRaw();
                    inflate.on('error', () => {});
                    inflate.on('data', onData);
                    socket.removeAllListeners('data');
                    socket.on('data', chunk => inflate.write(chunk));
                    deflate = zlib.createDeflateRaw();
                    deflate.on('error', () => {});
                    deflate.on('data', chunk => socket.write(chunk));
                    break;
                }
                case 'ENABLE':
                    write(`${tag} OK ENABLE completed`);
                    break;
                case 'LIST':
                case 'LSUB':
                    write(`* ${command} (\\HasNoChildren) "/" "INBOX"`);
                    write(`* ${command} (\\HasNoChildren \\Sent) "/" "Sent"`);
                    write(`${tag} OK ${command} completed`);
                    break;
                case 'STATUS':
                    write(`* STATUS ${parts[0]} (MESSAGES ${messages.length} UIDNEXT ${uidCounter + 1} UIDVALIDITY ${uidValidity})`);
                    write(`${tag} OK STATUS completed`);
                    break;
                case 'SELECT':
                case 'EXAMINE':
                    selected = true;
                    write('* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)');
                    write('* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] Flags permitted');
                    write(`* ${messages.length} EXISTS`);
                    write('* 0 RECENT');
                    write(`* OK [UIDVALIDITY ${uidValidity}] UIDs valid`);
                    write(`* OK [UIDNEXT ${uidCounter + 1}] Predicted next UID`);
                    write(`${tag} OK [${command === 'EXAMINE' ? 'READ-ONLY' : 'READ-WRITE'}] ${command} completed`);
                    break;
                case 'APPEND': {
                    // APPEND "INBOX" (\Seen) {123}   or with LITERAL+ {123+}
                    const literal = line.match(/\{(\d+)(\+?)\}$/);
                    if (!literal) {
                        write(`${tag} BAD APPEND needs a literal`);
                        break;
                    }
                    const flagsMatch = line.match(/\(([^)]*)\)/);
                    pending = {
                        tag,
                        flags: flagsMatch ? flagsMatch[1]!.split(' ').filter(Boolean) : [],
                        remaining: Number(literal[1]),
                        chunks: []
                    };
                    if (!literal[2]) {
                        write('+ Ready for literal data');
                    }
                    break;
                }
                case 'FETCH': {
                    if (!selected) {
                        write(`${tag} BAD No mailbox selected`);
                        break;
                    }
                    const set = parts[0] || '1:*';
                    const items = parts.slice(1).join(' ').toUpperCase();
                    for (const { seq, message } of selectMessages(messages, set, byUid)) {
                        const values: string[] = [`UID ${message.uid}`];
                        if (items.includes('FLAGS')) {
                            values.push(`FLAGS (${message.flags.join(' ')})`);
                        }
                        if (items.includes('RFC822.SIZE')) {
                            values.push(`RFC822.SIZE ${message.source.length}`);
                        }
                        if (items.includes('ENVELOPE')) {
                            values.push(`ENVELOPE ${envelope(message)}`);
                        }
                        const partial = items.match(/BODY(?:\.PEEK)?\[\]<(\d+)\.(\d+)>/);
                        if (partial) {
                            const start = Number(partial[1]);
                            const chunk = message.source.subarray(start, start + Number(partial[2]));
                            send(`* ${seq} FETCH (${values.join(' ')} BODY[]<${start}> {${chunk.length}}\r\n`);
                            send(chunk);
                            send(')\r\n');
                        } else if (items.includes('BODY[]') || items.includes('BODY.PEEK[]')) {
                            send(`* ${seq} FETCH (${values.join(' ')} BODY[] {${message.source.length}}\r\n`);
                            send(message.source);
                            send(')\r\n');
                        } else {
                            write(`* ${seq} FETCH (${values.join(' ')})`);
                        }
                    }
                    write(`${tag} OK FETCH completed`);
                    break;
                }
                case 'SEARCH': {
                    const criteria = parts.join(' ').toUpperCase();
                    const hits = messages
                        .map((message, i) => ({ seq: i + 1, message }))
                        .filter(entry => !criteria.includes('SEEN') || criteria.includes('UNSEEN') !== entry.message.flags.includes('\\Seen'))
                        .map(entry => (byUid ? entry.message.uid : entry.seq));
                    write(`* SEARCH${hits.length ? ' ' + hits.join(' ') : ''}`);
                    write(`${tag} OK SEARCH completed`);
                    break;
                }
                case 'NOOP':
                    write(`${tag} OK NOOP completed`);
                    break;
                case 'IDLE': {
                    write('+ idling');
                    // A message arrives while the client idles, announced with an untagged EXISTS
                    const timer = setTimeout(() => {
                        messages.push({
                            uid: ++uidCounter,
                            flags: [],
                            source: Buffer.from('Subject: arrived while idling\r\nFrom: sender@example.com\r\n\r\nNew mail\r\n')
                        });
                        write(`* ${messages.length} EXISTS`);
                    }, 200);
                    idling = { tag, timer };
                    break;
                }
                case 'CLOSE':
                    selected = false;
                    write(`${tag} OK CLOSE completed`);
                    break;
                case 'LOGOUT':
                    write('* BYE Logging out');
                    write(`${tag} OK LOGOUT completed`);
                    if (deflate) {
                        deflate.end();
                    }
                    socket.end();
                    break;
                default:
                    write(`${tag} BAD Unknown command ${command}`);
            }
        };

        function onData(chunk: Buffer) {
            buffer = Buffer.concat([buffer, chunk]);
            for (;;) {
                if (pending) {
                    const take = Math.min(pending.remaining, buffer.length);
                    pending.chunks.push(buffer.subarray(0, take));
                    buffer = buffer.subarray(take);
                    pending.remaining -= take;
                    if (pending.remaining > 0) {
                        return;
                    }
                    const message = { uid: ++uidCounter, flags: pending.flags, source: Buffer.concat(pending.chunks) };
                    messages.push(message);
                    if (selected) {
                        write(`* ${messages.length} EXISTS`);
                    }
                    write(`${pending.tag} OK [APPENDUID ${uidValidity} ${message.uid}] APPEND completed`);
                    pending = null;
                    // the CRLF that terminates the APPEND command line follows the literal
                    const eol = buffer.indexOf('\n');
                    if (eol === -1) {
                        return;
                    }
                    buffer = buffer.subarray(eol + 1);
                    continue;
                }
                const eol = buffer.indexOf('\n');
                if (eol === -1) {
                    return;
                }
                const line = buffer.subarray(0, eol).toString('binary').replace(/\r$/, '');
                buffer = buffer.subarray(eol + 1);
                if (line) {
                    handleLine(line);
                }
            }
        }

        socket.on('data', onData);
        write(`* OK [CAPABILITY ${capabilityList(secure).join(' ')}] imapflow mock ready`);
    };

    const server = opts.secure ? tls.createServer({ cert, key }, handleConnection) : net.createServer(handleConnection);
    const sockets = new Set<net.Socket>();
    server.on('connection', socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address() as net.AddressInfo;
            resolve({
                port: address.port,
                host: '127.0.0.1',
                messages,
                commands,
                close: () =>
                    new Promise<void>(done => {
                        for (const socket of sockets) {
                            socket.destroy();
                        }
                        server.close(() => done());
                    })
            });
        });
    });
};
