// End-to-end sessions against ImapKit (https://github.com/postalsys/imapkit), an in-memory IMAP
// server that runs in-process. Unlike the Docker backends in test/integration/ it can be set up
// per test with any capability set, any starting mailbox tree and any user list, and it answers
// client input that breaks the RFCs with BAD, so a session that completes without a BAD is a
// syntax check of what the client sent.
//
// ImapKit keeps one mailbox tree that every user of a server shares, so every test starts its own
// server on a random port. startImapKit() registers the cleanup on the test context.

import assert from 'node:assert/strict';
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
    // A connected client
    connect(options?: Record<string, any>): Promise<any>;
    // Lines the client sent, or the server sent, for quick assertions
    sent(needle: string | RegExp): boolean;
    received(needle: string | RegExp): boolean;
    // Resolves once a client has sent a matching line, rejects after `ms`
    untilSent(needle: string | RegExp, ms?: number): Promise<void>;
    // Delivers a message from outside the IMAP sessions, like an MTA would
    deliver(path: string, raw: string, flags?: string[]): any;
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
    // untilSent() callers, checked against each new line the client sends
    const waiters = new Set<(msg: string) => void>();

    const connect = async (clientOptions: Record<string, any> = {}) => {
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
                if (entry.src === 'c') {
                    for (const waiter of waiters) {
                        waiter(entry.msg);
                    }
                }
            }
        });
        // a session the server closes must not crash the test process
        client.on('error', () => {});
        clients.add(client);
        await client.connect();
        return client;
    };

    const sent = (needle: string | RegExp) => wire.some(entry => entry.src === 'c' && matches(entry.msg, needle));

    const untilSent = (needle: string | RegExp, ms = 3000) =>
        new Promise<void>((resolve, reject) => {
            if (sent(needle)) {
                return resolve();
            }
            let timer: ReturnType<typeof setTimeout>;
            const waiter = (msg: string) => matches(msg, needle) && done();
            function done(err?: Error) {
                clearTimeout(timer);
                waiters.delete(waiter);
                return err ? reject(err) : resolve();
            }
            timer = setTimeout(() => done(new Error(`${needle} not sent within ${ms}ms`)), ms);
            waiters.add(waiter);
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
        connect,
        sent,
        received: needle => wire.some(entry => entry.src === 's' && matches(entry.msg, needle)),
        untilSent,
        deliver: (path, raw, flags = []) => server.appendMessage(path, flags, undefined, raw)
    };
};

// Set without \Recent, which only IMAP4rev1 sessions report, sorted for comparing
export const flagList = (flags: Set<string>) => [...flags].filter(flag => flag !== '\\Recent').sort();

// Builds a simple RFC 5322 message
export const rfc822 = (subject: string, body = 'Hello world', extraHeaders = '') =>
    `From: Sender <sender@example.com>\r\nTo: Receiver <receiver@example.com>\r\nSubject: ${subject}\r\nMessage-ID: <${subject.replace(/[^a-z0-9]/gi, '')}@example.com>\r\nDate: Mon, 6 Oct 2025 10:00:00 +0000\r\n${extraHeaders}\r\n${body}\r\n`;
