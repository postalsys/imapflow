import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// The suite runs through tsx, which strips the types instead of checking them, and
// `npm run typecheck` checks the types in src/. These tests type-check a consumer against
// the built declarations in dist/ the way an installed copy is resolved: the package is
// linked into a temporary project so that the specifiers go through the package.json
// exports map.
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tsc = require.resolve('typescript/bin/tsc');
// the oldest @types/node of the supported Node line, see the emitter tests
const legacyNodeTypes = path.join(root, 'node_modules', 'types-node-legacy');

const hasDist = fs.existsSync(path.join(root, 'dist', 'cjs', 'imap-flow.d.ts')) && fs.existsSync(path.join(root, 'dist', 'esm', 'imap-flow.d.ts'));

// The idioms the hand-written imap-flow.d.ts supported, kept compiling by the shipped
// declarations: the named ImapFlow export, the default export object, the documented option
// and result types, the typed events, and the async iterator returned by fetch(). The
// listener parameters are left unannotated on purpose, under noImplicitAny they only
// compile when the listener is typed from the event name
const consumer = `
import { ImapFlow, AuthenticationFailure } from 'imapflow';
import imapflow from 'imapflow';
import type {
    ImapFlowOptions,
    FetchMessageObject,
    FetchQueryObject,
    ListResponse,
    ListTreeResponse,
    SearchObject,
    MailboxObject,
    MailboxLockObject,
    StatusObject,
    QuotaResponse,
    ESearchResult,
    DownloadObject,
    AppendResponseObject,
    CopyResponseObject,
    ExpungeEvent,
    Logger,
    ImapFlowError
} from 'imapflow';

const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
};

const options: ImapFlowOptions = {
    host: 'imap.example.com',
    port: 993,
    secure: true,
    auth: { user: 'user', pass: 'pass' },
    logger,
    tls: { rejectUnauthorized: false },
    clientInfo: { name: 'consumer', version: '1.0.0' },
    expungeHandler: async (event: ExpungeEvent) => {
        event.path;
    }
};

const client = new ImapFlow(options);
const viaDefault = new imapflow.ImapFlow({ host: 'localhost', auth: { user: 'user', accessToken: 'token' }, logger: false });
const version: string = ImapFlow.version;

client.on('exists', data => data.count);
client.on('expunge', data => data.vanished);
client.on('flags', data => data.flags.has('\\\\Seen'));
client.on('mailboxOpen', mailbox => mailbox.path);
client.on('mailboxClose', mailbox => mailbox.path);
client.on('log', entry => entry.level);
client.on('response', response => response.code);
client.on('error', err => err.message);
client.on('close', () => {});

export async function run(): Promise<void> {
    await client.connect();
    const mailbox: MailboxObject | false = client.mailbox;
    const capabilities: Map<string, boolean | number> = client.capabilities;
    const enabled: Set<string> = client.enabled;
    const authenticated: string | boolean = client.authenticated;
    void [mailbox, capabilities, enabled, authenticated, version, viaDefault];

    const lock: MailboxLockObject = await client.getMailboxLock('INBOX', { readOnly: true, acquireTimeout: 1000 });
    try {
        const list: ListResponse[] = await client.list({ statusQuery: { messages: true, unseen: true }, specialUseHints: { sent: 'Sent' } });
        list.forEach(entry => entry.flags.has('\\\\Noselect'));
        const tree: ListTreeResponse = await client.listTree();
        tree.folders?.forEach(folder => folder.path);
        const status: StatusObject = await client.status('INBOX', { messages: true, uidNext: true });
        status.messages;
        const quota: QuotaResponse | false = await client.getQuota('INBOX');
        if (quota) {
            quota.storage?.used;
        }

        const query: SearchObject = { seen: false, since: new Date(), or: [{ from: 'a@example.com' }, { subject: 'hello' }], header: { 'X-Test': true } };
        const uids = await client.search(query, { uid: true });
        if (Array.isArray(uids)) {
            uids.forEach(uid => uid.toFixed());
        }
        const esearch = await client.search(query, { uid: true, returnOptions: ['COUNT', 'ALL'] });
        if (esearch && !Array.isArray(esearch)) {
            const result: ESearchResult = esearch;
            result.count;
        }

        const fetchQuery: FetchQueryObject = { uid: true, envelope: true, bodyStructure: true, flags: true, headers: ['subject'], bodyParts: ['1', { key: '2', start: 0, maxLength: 10 }] };
        for await (const message of client.fetch('1:*', fetchQuery, { uid: false })) {
            const m: FetchMessageObject = message;
            m.envelope?.subject;
            m.bodyStructure?.childNodes;
            m.flags?.has('\\\\Seen');
        }
        const all: FetchMessageObject[] = await client.fetchAll([1, 2, 3], { source: true }, { uid: true, changedSince: 1n });
        all.forEach(entry => entry.source?.length);
        const one = await client.fetchOne('*', { source: { start: 0, maxLength: 1024 } });
        if (one) {
            one.uid.toFixed();
        }

        await client.messageFlagsAdd({ seen: false }, ['\\\\Seen'], { uid: true, silent: true });
        await client.messageFlagsRemove('1:*', ['\\\\Flagged']);
        await client.messageFlagsSet([1, 2], ['\\\\Seen'], { unchangedSince: 5n });
        await client.setFlagColor('1', 'red');
        await client.messageDelete({ deleted: true }, { uid: true });
        const copied: CopyResponseObject | false = await client.messageCopy('1:3', 'Archive', { uid: true });
        if (copied) {
            copied.uidMap?.size;
        }
        const moved: CopyResponseObject | false = await client.messageMove('1:3', ['Parent', 'Child']);
        void moved;
        const appended: AppendResponseObject | false = await client.append('INBOX', Buffer.from('Subject: x\\r\\n\\r\\nbody'), ['\\\\Seen'], new Date());
        if (appended) {
            appended.uid;
        }

        const download = await client.download('1', '2', { uid: true, maxBytes: 1024, chunkSize: 512 });
        if (download.content) {
            const full: DownloadObject = download as DownloadObject;
            full.meta.contentType;
            download.content.on('data', () => {});
        }
        const many = await client.downloadMany('1', ['2', '3'], { uid: true });
        Object.keys(many).forEach(part => many[part].content);

        const created = await client.mailboxCreate(['Parent', 'Child']);
        created.created;
        const renamed = await client.mailboxRename('Parent/Child', 'Parent/Renamed');
        renamed.newPath;
        const deleted = await client.mailboxDelete('Parent/Renamed');
        deleted.path;
        await client.mailboxSubscribe('INBOX');
        await client.mailboxUnsubscribe('INBOX');
        const opened: MailboxObject = await client.mailboxOpen('INBOX', { readOnly: false });
        opened.exists;
        await client.mailboxClose();
        await client.noop();
        const stats: { sent: number; received: number } = client.stats(true);
        stats.sent;
    } finally {
        lock.release();
    }

    try {
        await client.idle();
    } catch (err) {
        const failure = err as ImapFlowError;
        failure.code;
        failure.responseStatus;
        if (err instanceof AuthenticationFailure) {
            err.authenticationFailed;
            const response: string | undefined = err.response;
            void response;
        }
    }

    await client.logout();
    client.close();
}
`;

// A CommonJS consumer, the way the package was loaded before the ES module build existed
const cjsConsumer = `
import imapflow = require('imapflow');
import type { ImapFlowOptions, FetchMessageObject } from 'imapflow';

const options: ImapFlowOptions = { host: 'imap.example.com', port: 993, secure: true, auth: { user: 'user', pass: 'pass' } };
const client = new imapflow.ImapFlow(options);
const other = new imapflow.default.ImapFlow(options);

export async function run(): Promise<void> {
    await client.connect();
    const messages: FetchMessageObject[] = await client.fetchAll('1:*', { envelope: true });
    messages.forEach(message => message.seq);
    await client.logout();
    other.close();
}
`;

// Every optional property is declared as \`T | undefined\` so that an explicit undefined is
// still accepted under exactOptionalPropertyTypes, the way the hand-written imap-flow.d.ts
// declared them. Building an options object out of values that may be undefined is the shape
// that breaks first, so the option interfaces are filled in that way here, and a mapped-type
// sweep then checks every optional property of every public interface
const exactOptionalConsumer = `
import { ImapFlow } from 'imapflow';
import type {
    ImapFlowOptions,
    FetchQueryObject,
    FetchOptions,
    SearchObject,
    SearchOptions,
    ListOptions,
    StatusQuery,
    StoreOptions,
    MailboxOpenOptions,
    MailboxLockOptions,
    DownloadOptions,
    IdInfoObject,
    MailboxObject,
    ListResponse,
    ListTreeResponse,
    StatusObject,
    QuotaResponse,
    FetchMessageObject,
    MessageEnvelopeObject,
    MessageStructureObject,
    AppendResponseObject,
    CopyResponseObject,
    ESearchResult,
    ExpungeEvent,
    FlagsEvent,
    DownloadObject,
    Logger
} from 'imapflow';

declare const maybeString: string | undefined;
declare const maybeNumber: number | undefined;
declare const maybeBoolean: boolean | undefined;
declare const maybeBigint: bigint | undefined;
declare const maybeLogger: Logger | undefined;

const client = new ImapFlow({
    host: maybeString,
    port: maybeNumber,
    secure: maybeBoolean,
    servername: maybeString,
    logger: maybeLogger,
    auth: { user: 'user', pass: maybeString, accessToken: maybeString, loginMethod: maybeString, authzid: maybeString },
    clientInfo: { name: maybeString, version: maybeString },
    proxy: maybeString,
    connectionTimeout: maybeNumber,
    maxLockHoldTime: maybeNumber,
    disableAutoIdle: maybeBoolean
});

export async function run(): Promise<void> {
    const fetchQuery: FetchQueryObject = { uid: maybeBoolean, envelope: maybeBoolean, headers: maybeBoolean, bodyParts: [{ key: '1', start: maybeNumber, maxLength: maybeNumber }] };
    const fetchOptions: FetchOptions = { uid: maybeBoolean, changedSince: maybeBigint, binary: maybeBoolean };
    const search: SearchObject = { seen: maybeBoolean, from: maybeString, larger: maybeNumber, modseq: maybeBigint };
    const searchOptions: SearchOptions = { uid: maybeBoolean };
    const listOptions: ListOptions = { statusQuery: { messages: maybeBoolean, unseen: maybeBoolean }, specialUseHints: { sent: maybeString } };
    const storeOptions: StoreOptions = { uid: maybeBoolean, unchangedSince: maybeBigint, useLabels: maybeBoolean, silent: maybeBoolean };
    const lockOptions: MailboxLockOptions = { readOnly: maybeBoolean, description: maybeString, acquireTimeout: maybeNumber, maxLockHoldTime: maybeNumber };
    const downloadOptions: DownloadOptions = { uid: maybeBoolean, maxBytes: maybeNumber, chunkSize: maybeNumber };

    await client.getMailboxLock('INBOX', lockOptions);
    await client.list(listOptions);
    await client.search(search, searchOptions);
    await client.fetchAll('1:*', fetchQuery, fetchOptions);
    await client.messageFlagsAdd('1', ['\\\\Seen'], storeOptions);
    await client.download('1', undefined, downloadOptions);
}

// The call shapes above only pin the properties they name. This sweeps every optional
// property of the public types instead, so that one added without \\\`| undefined\\\` fails here
// rather than in a consumer project. OptionalKeys picks the keys that may be left out, and
// MissingUndefined keeps the ones that do not accept undefined
type OptionalKeys<T> = Extract<{ [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T], string>;
type MissingUndefined<T> = { [K in OptionalKeys<T>]-?: { [P in K]: undefined } extends Pick<T, K> ? never : K }[OptionalKeys<T>];
type NoneMissing<T extends never> = T;

type _ImapFlowOptions = NoneMissing<MissingUndefined<ImapFlowOptions>>;
type _FetchQueryObject = NoneMissing<MissingUndefined<FetchQueryObject>>;
type _FetchOptions = NoneMissing<MissingUndefined<FetchOptions>>;
type _SearchObject = NoneMissing<MissingUndefined<SearchObject>>;
type _SearchOptions = NoneMissing<MissingUndefined<SearchOptions>>;
type _ListOptions = NoneMissing<MissingUndefined<ListOptions>>;
type _StatusQuery = NoneMissing<MissingUndefined<StatusQuery>>;
type _StoreOptions = NoneMissing<MissingUndefined<StoreOptions>>;
type _MailboxOpenOptions = NoneMissing<MissingUndefined<MailboxOpenOptions>>;
type _MailboxLockOptions = NoneMissing<MissingUndefined<MailboxLockOptions>>;
type _DownloadOptions = NoneMissing<MissingUndefined<DownloadOptions>>;
type _IdInfoObject = NoneMissing<MissingUndefined<IdInfoObject>>;
type _MailboxObject = NoneMissing<MissingUndefined<MailboxObject>>;
type _ListResponse = NoneMissing<MissingUndefined<ListResponse>>;
type _ListTreeResponse = NoneMissing<MissingUndefined<ListTreeResponse>>;
type _StatusObject = NoneMissing<MissingUndefined<StatusObject>>;
type _QuotaResponse = NoneMissing<MissingUndefined<QuotaResponse>>;
type _FetchMessageObject = NoneMissing<MissingUndefined<FetchMessageObject>>;
type _MessageEnvelopeObject = NoneMissing<MissingUndefined<MessageEnvelopeObject>>;
type _MessageStructureObject = NoneMissing<MissingUndefined<MessageStructureObject>>;
type _AppendResponseObject = NoneMissing<MissingUndefined<AppendResponseObject>>;
type _CopyResponseObject = NoneMissing<MissingUndefined<CopyResponseObject>>;
type _ESearchResult = NoneMissing<MissingUndefined<ESearchResult>>;
type _ExpungeEvent = NoneMissing<MissingUndefined<ExpungeEvent>>;
type _FlagsEvent = NoneMissing<MissingUndefined<FlagsEvent>>;
type _DownloadObject = NoneMissing<MissingUndefined<DownloadObject>>;
`;

// The class extends the plain EventEmitter and types its events through overloads, so the
// idioms the untyped base allowed keep compiling: holding the client in the EventEmitter
// type and listening for an event outside the map. The other emitter methods get the same
// overloads as on(), which the main consumer covers
const emitterConsumer = `
import { EventEmitter } from 'node:events';
import { ImapFlow } from 'imapflow';
import type { ExistsEvent } from 'imapflow';

const client = new ImapFlow({ host: 'localhost' });

const emitter: EventEmitter = client;
const nodeEmitter: NodeJS.EventEmitter = client;
void [emitter, nodeEmitter];

const listener = (data: ExistsEvent): number => data.count;
client.once('expunge', data => data.path);
client.addListener('flags', data => data.flags.has('\\\\Seen'));
client.prependListener('mailboxOpen', mailbox => mailbox.path);
client.prependOnceListener('mailboxClose', mailbox => mailbox.exists);
client.on('exists', listener).off('exists', listener).removeListener('exists', listener);
client.emit('exists', { path: 'INBOX', count: 1, prevCount: 0 });
client.emit('close');

client.on('custom', (...args) => args.length);
client.emit('custom', 1, 'two');
client.off('custom', () => {});
client.removeAllListeners('custom');
client.listenerCount('custom');
client.eventNames();
`;

// node16 is what an installed copy resolves through the exports map (as an ES module project
// and as a CommonJS one), bundler is what the common front end tool chains use
const node16 = { module: 'node16', moduleResolution: 'node16' };
const resolutions: Array<{ name: string; compilerOptions: { [key: string]: unknown }; type?: string }> = [
    { name: 'node16 ES module project', compilerOptions: node16, type: 'module' },
    { name: 'node16 CommonJS project', compilerOptions: node16 },
    { name: 'bundler resolution', compilerOptions: { module: 'esnext', moduleResolution: 'bundler' }, type: 'module' }
];

// Type-checks one or more consumer sources against the built declarations in dist/ the way
// an installed copy is resolved: the package is linked into a temporary project so that the
// specifiers go through the package.json exports map. nodeTypes is the @types/node the
// consumer compiles with, the one of the repository by default
const typeCheckConsumer = (
    sources: string | string[],
    compilerOptions: { [key: string]: unknown },
    type?: string,
    nodeTypes = path.join(root, 'node_modules', '@types', 'node')
): void => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imapflow-types-'));
    try {
        fs.mkdirSync(path.join(dir, 'node_modules'));
        // link the package itself and the node typings a real consumer has, so that
        // the specifiers resolve the way they do in an installed project
        fs.symlinkSync(root, path.join(dir, 'node_modules', 'imapflow'), 'dir');
        fs.mkdirSync(path.join(dir, 'node_modules', '@types'));
        fs.symlinkSync(nodeTypes, path.join(dir, 'node_modules', '@types', 'node'), 'dir');
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'consumer', private: true, ...(type ? { type } : {}) }));
        const files = (Array.isArray(sources) ? sources : [sources]).map((source, index) => {
            const name = 'consumer' + index + '.ts';
            fs.writeFileSync(path.join(dir, name), source);
            return name;
        });
        fs.writeFileSync(
            path.join(dir, 'tsconfig.json'),
            JSON.stringify({
                compilerOptions: {
                    target: 'ES2022',
                    lib: ['ES2023'],
                    types: ['node'],
                    strict: true,
                    exactOptionalPropertyTypes: true,
                    noEmit: true,
                    skipLibCheck: true,
                    esModuleInterop: true,
                    ...compilerOptions
                },
                include: files
            })
        );

        const result = spawnSync(process.execPath, [tsc, '-p', path.join(dir, 'tsconfig.json')], { encoding: 'utf8' });
        assert.strictEqual(result.status, 0, 'tsc reported\n' + result.stdout + result.stderr);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
};

describe('Built package types', { timeout: 120 * 1000, skip: hasDist ? false : 'dist/ is not built, run npm run build first' }, () => {
    for (const resolution of resolutions) {
        it('type-checks an ES module consumer with ' + resolution.name, () => {
            typeCheckConsumer(consumer, resolution.compilerOptions, resolution.type);
        });

        it('accepts explicit undefined for every optional property with ' + resolution.name, () => {
            typeCheckConsumer(exactOptionalConsumer, resolution.compilerOptions, resolution.type);
        });
    }

    it('type-checks a CommonJS consumer', () => {
        // no "type": "module" in the consumer package, so the file is a CommonJS module
        typeCheckConsumer(cjsConsumer, node16);
    });

    it('types the events through overloads and keeps the plain EventEmitter idioms', () => {
        typeCheckConsumer(emitterConsumer, node16, 'module');
    });

    it('type-checks a consumer with the oldest @types/node of the supported Node line', () => {
        // the alias predates the generic EventEmitter, which the declarations must not depend
        // on: a consumer on such a release would lose every emitter method of the class
        const events = fs.readFileSync(path.join(legacyNodeTypes, 'events.d.ts'), 'utf8');
        assert.ok(!/class EventEmitter</.test(events), 'types-node-legacy has a generic EventEmitter, pin an older release');
        typeCheckConsumer([consumer, emitterConsumer], node16, 'module', legacyNodeTypes);
    });

    it('does not leak module types the consumer does not have', () => {
        // the declarations must not reference the untyped runtime dependencies
        // (libmime, libqp, libbase64, encoding-japanese), whose types only exist as an
        // ambient declaration inside this repository
        const dir = path.join(root, 'dist', 'esm');
        const files = (fs.readdirSync(dir, { recursive: true }) as string[]).filter(name => name.endsWith('.d.ts'));
        for (const name of files) {
            const content = fs.readFileSync(path.join(dir, name), 'utf8');
            for (const dependency of ['libmime', 'libqp', 'libbase64', 'encoding-japanese']) {
                assert.ok(!new RegExp(`from '${dependency}'`).test(content), name + ' references ' + dependency);
                assert.ok(!new RegExp(`import\\("${dependency}"\\)`).test(content), name + ' references ' + dependency);
            }
        }
    });
});
