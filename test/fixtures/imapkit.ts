// End-to-end sessions against ImapKit (https://github.com/postalsys/imapkit), an in-memory IMAP
// server that runs in-process. Unlike the Docker backends in test/integration/ it can be set up
// per test with any capability set, any starting mailbox tree and any user list, and it answers
// client input that breaks the RFCs with BAD, so a session that completes without a BAD is a
// syntax check of what the client sent.
//
// ImapKit keeps one mailbox tree that every user of a server shares, so every test starts its own
// server on a random port. startImapKit() registers the cleanup on the test context.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import imapkit from 'imapkit';

import { ImapFlow } from '../../src/imap-flow.js';
import { listen } from './scripted-server.js';

type Server = ReturnType<typeof imapkit>;

// Every plugin that can be loaded together with the others. Left out: ACL (non-owner users lose
// their rights), LITERALMINUS and SAVELIMIT (conflict with LITERALPLUS and MESSAGELIMIT),
// LOGINDISABLED and UIDONLY (change how a session works, tested on their own), METADATA-SERVER (a
// subset of METADATA) and XTOYBIRD (test control commands).
export const ALL_PLUGINS = [
    'APPENDLIMIT',
    'AUTH-PLAIN',
    'BINARY',
    'CATENATE',
    'COMPRESS',
    'CONDSTORE',
    'CONTEXT=SEARCH',
    'CONTEXT=SORT',
    'CREATE-SPECIAL-USE',
    'ENABLE',
    'ESEARCH',
    'ESORT',
    'ID',
    'IDLE',
    'IMAP4rev2',
    'LIST-EXTENDED',
    'LIST-STATUS',
    'LITERALPLUS',
    'MESSAGELIMIT',
    'METADATA',
    'MOVE',
    'MULTIAPPEND',
    'MULTISEARCH',
    'NAMESPACE',
    'NOTIFY',
    'OAUTHBEARER',
    'OBJECTID',
    'PARTIAL',
    'PREVIEW',
    'QRESYNC',
    'QUOTA',
    'REPLACE',
    'SASL-IR',
    'SAVEDATE',
    'SEARCHRES',
    'SORT',
    'SORT=DISPLAY',
    'SPECIAL-USE',
    'STARTTLS',
    'STATUS=SIZE',
    'THREAD=ORDEREDSUBJECT',
    'THREAD=REFERENCES',
    'UIDPLUS',
    'UNAUTHENTICATE',
    'UNSELECT',
    'UTF8=ACCEPT',
    'X-GM-EXT-1',
    'XOAUTH2'
];

// A mailbox tree with the usual special-use folders
const DEFAULT_STORAGE = {
    INBOX: {},
    '': {
        separator: '/',
        folders: {
            Archive: { 'special-use': '\\Archive' },
            Drafts: { 'special-use': '\\Drafts' },
            Junk: { 'special-use': '\\Junk' },
            Sent: { 'special-use': '\\Sent' },
            Trash: { 'special-use': '\\Trash' }
        }
    }
};

interface WireEntry {
    src: 'c' | 's';
    msg: string;
}

export interface ImapKit {
    // Scripted faults of the server, `add()` takes ImapKit script rules at runtime
    script: Server['script'];
    // The control API: server side changes (messages, flags, UIDVALIDITY ...) that reach the
    // connected sessions like a change by another session, and inspection of the server state
    control: Server['control'];
    // Resolves with the first server event (`session`, `command`, ...) that `match` accepts
    serverEvent(event: string, match?: (data: any) => boolean, ms?: number): Promise<any>;
    // A connected client, `setup` gets it before it connects (listeners for events of the session setup)
    connect(options?: Record<string, any>, setup?: (client: any) => void): Promise<any>;
    // Lines the client sent, or the server sent, for quick assertions
    sent(needle: string | RegExp): boolean;
    received(needle: string | RegExp): boolean;
}

const matches = (msg: string, needle: string | RegExp) => (typeof needle === 'string' ? msg.includes(needle) : needle.test(msg));

// `server` takes ImapKit server options (plugins, storage, users, script, ...). A BAD on the wire
// fails the test unless `allowBad` is set, for faults that send one on purpose.
export const startImapKit = async (t: any, options: { server?: Record<string, any>; allowBad?: boolean } = {}): Promise<ImapKit> => {
    const server = imapkit(Object.assign({ plugins: ALL_PLUGINS, storage: DEFAULT_STORAGE }, options.server || {}));
    const port = await listen(server);

    const clients = new Set<any>();
    // Wire lines of every client of this server, in order
    const wire: WireEntry[] = [];
    const connect = async (clientOptions: Record<string, any> = {}, setup?: (client: any) => void) => {
        const client: any = new ImapFlow(
            Object.assign(
                {
                    host: '127.0.0.1',
                    port,
                    secure: !!(options.server && options.server.secureConnection),
                    // ImapKit uses a bundled self-signed certificate for STARTTLS and implicit TLS
                    tls: { rejectUnauthorized: false },
                    auth: { user: 'testuser', pass: 'testpass' },
                    logger: false as const,
                    emitLogs: true,
                    disableAutoIdle: true
                },
                clientOptions
            )
        );
        client.on('log', (entry: any) => {
            if (entry && (entry.src === 'c' || entry.src === 's') && typeof entry.msg === 'string') {
                wire.push({ src: entry.src, msg: entry.msg });
            }
        });
        // a session the server closes must not crash the test process
        client.on('error', () => {});
        clients.add(client);
        setup?.(client);
        await client.connect();
        return client;
    };

    const sent = (needle: string | RegExp) => wire.some(entry => entry.src === 'c' && matches(entry.msg, needle));

    const serverEvent = (event: string, match: (data: any) => boolean = () => true, ms = 3000) =>
        new Promise<any>((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout>;
            const listener = (data: any) => {
                if (match(data)) {
                    clearTimeout(timer);
                    server.off(event, listener);
                    resolve(data);
                }
            };
            timer = setTimeout(() => {
                server.off(event, listener);
                reject(new Error(`no matching ${event} event within ${ms}ms`));
            }, ms);
            server.on(event, listener);
        });

    t.after(async () => {
        for (const client of clients) {
            client.close();
        }
        await new Promise<void>(resolve => server.close(() => resolve()));
        if (!options.allowBad) {
            const bad = wire.filter(entry => entry.src === 's' && /^\S+ BAD( |$)/.test(entry.msg));
            assert.deepEqual(
                bad.map(entry => entry.msg),
                [],
                'ImapKit answered client input with BAD'
            );
        }
    });

    return {
        script: server.script,
        control: server.control,
        serverEvent,
        connect,
        sent,
        received: needle => wire.some(entry => entry.src === 's' && matches(entry.msg, needle))
    };
};

// The whole content of a download() stream
export const readContent = async (content: any): Promise<Buffer> => Buffer.concat(await content.toArray());

// once() that fails the test instead of hanging when the event never comes
export const within = (emitter: any, event: string) => once(emitter, event, { signal: AbortSignal.timeout(3000) });

// Resolves when the client closed. once(client, 'close') would reject on the 'error' event that
// comes before the close
export const closed = (client: any) => new Promise(resolve => client.once('close', resolve));

// Set without \Recent, which only IMAP4rev1 sessions report, sorted for comparing
export const flagList = (flags: Set<string>) => [...flags].filter(flag => flag !== '\\Recent').sort();

// Builds a simple RFC 5322 message
export const rfc822 = (subject: string, body = 'Hello world', extraHeaders = '') =>
    `From: Sender <sender@example.com>\r\nTo: Receiver <receiver@example.com>\r\nSubject: ${subject}\r\nMessage-ID: <${subject.replace(/[^a-z0-9]/gi, '')}@example.com>\r\nDate: Mon, 6 Oct 2025 10:00:00 +0000\r\n${extraHeaders}\r\n${body}\r\n`;
