// A Cloudflare Worker that drives an ImapFlow session against the server named in the
// request body and reports what it saw. Run by test/cloudflare/cloudflare-test.ts under
// workerd through `wrangler dev`, so the ES module build is exercised on the Workers
// runtime with nodejs_compat rather than on Node.js.
//
// Imports the built ES module output on purpose: that is what an installed copy of the
// package loads. The file is excluded from the project type-check for the same reason, the
// declarations next to the build only exist once `npm run build` has run.

import { connect } from 'cloudflare:sockets';
import { ImapFlow, createSocketsTransport } from '../../dist/esm/imap-flow.js';

export interface Scenario {
    host: string;
    port: number;
    secure?: boolean | undefined;
    doSTARTTLS?: boolean | undefined;
    /** Credentials. Without them connect() stops right after the STARTTLS negotiation */
    auth?: { user: string; pass: string } | undefined;
    tls?: { rejectUnauthorized?: boolean | undefined; ca?: string | undefined } | undefined;
    servername?: string | undefined;
    proxy?: string | undefined;
    /** Connect through createSocketsTransport() over cloudflare:sockets instead of node:net and node:tls */
    transport?: 'sockets' | undefined;
    mailbox?: string | undefined;
    /** A message to APPEND before fetching */
    append?: string | undefined;
    /** Pad the appended message body to this many bytes */
    appendSize?: number | undefined;
    /** download() the appended message and report its size */
    download?: boolean | undefined;
    /** Use the default (pino) logger instead of turning logging off */
    defaultLogger?: boolean | undefined;
    logRaw?: boolean | undefined;
    socketTimeout?: number | undefined;
    disableCompression?: boolean | undefined;
    /** Enter IDLE after fetching and wait for the server to announce a new message */
    idle?: boolean | undefined;
    /** Run the API tour (runTour) instead of the default session, needs a full server such as ImapKit */
    tour?: boolean | undefined;
}

export interface ScenarioResult {
    ok: boolean;
    error?: { message: string; code?: string | undefined; tlsFailed?: boolean | undefined } | undefined;
    steps: string[];
    greeting?: string | undefined;
    capabilities?: string[] | undefined;
    secureConnection?: boolean | undefined;
    tls?: unknown;
    compressed?: boolean | undefined;
    list?: string[] | undefined;
    mailbox?: { path: string; exists: number; uidValidity: string } | null | undefined;
    appended?: { uid?: number | undefined; seq?: number | undefined } | false | undefined;
    messages?: Array<{ uid: number; subject?: string | undefined; size?: number | undefined; flags: string[]; source?: string | undefined }> | undefined;
    search?: number[] | false | undefined;
    /** The EXISTS event received while idling, and the message count after IDLE ended */
    idle?: { count: number; prevCount: number; existsAfter: number } | undefined;
    /** Bytes read through download() */
    downloaded?: number | undefined;
    stats?: { sent: number; received: number } | undefined;
    /** What each step of the API tour returned */
    tour?: Record<string, unknown> | undefined;
    logs: string[];
}

// Builds the message the scenario appends, padded to appendSize bytes with base64-like lines
const messageSource = (scenario: Scenario): string | undefined => {
    if (!scenario.append || !scenario.appendSize || scenario.append.length >= scenario.appendSize) {
        return scenario.append;
    }
    const line = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/ABCDEFGHIJKL\r\n';
    return scenario.append + line.repeat(Math.ceil((scenario.appendSize - scenario.append.length) / line.length));
};

export const createClient = (scenario: Scenario, result: ScenarioResult): ImapFlow => {
    const client = new ImapFlow({
        host: scenario.host,
        port: scenario.port,
        secure: !!scenario.secure,
        doSTARTTLS: scenario.doSTARTTLS,
        auth: scenario.auth,
        tls: scenario.tls,
        servername: scenario.servername,
        proxy: scenario.proxy,
        transport: scenario.transport === 'sockets' ? createSocketsTransport(connect) : undefined,
        logger: scenario.defaultLogger ? undefined : false,
        emitLogs: true,
        logRaw: !!scenario.logRaw,
        disableAutoIdle: true,
        disableCompression: !!scenario.disableCompression,
        connectionTimeout: 15 * 1000,
        greetingTimeout: 15 * 1000,
        socketTimeout: scenario.socketTimeout || 15 * 1000,
        clientInfo: { name: 'imapflow-workers-test' }
    });
    client.on('log', entry => {
        if (entry.level !== 'trace' || scenario.logRaw) {
            const data = entry.data ? ' ' + Buffer.from(entry.data, 'base64').toString('binary').replace(/\r?\n/g, '\\n') : '';
            result.logs.push(
                `${entry.level}: ${entry.src ? entry.src + ' ' : ''}${entry.msg || ''}${data}${entry.err ? ' ' + (entry.err.message || entry.err) : ''}`
            );
        }
    });
    client.on('error', err => {
        result.logs.push('error event: ' + err.message);
    });
    return client;
};

const TOUR_ATTACHMENT = 'attachment content '.repeat(200);

const tourMessage = (subject: string): string =>
    [
        `Subject: ${subject}`,
        'From: sender@example.com',
        'To: recipient@example.com',
        `Message-ID: <${subject.replace(/\W/g, '')}@example.com>`,
        'Date: Mon, 7 Sep 2026 10:00:00 +0000',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="tour"',
        '',
        '--tour',
        'Content-Type: text/plain; charset=utf-8',
        '',
        `Body of ${subject}`,
        '--tour',
        'Content-Type: application/octet-stream; name="data.bin"',
        'Content-Disposition: attachment; filename="data.bin"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from(TOUR_ATTACHMENT).toString('base64').replace(/.{76}/g, '$&\r\n'),
        '--tour--',
        ''
    ].join('\r\n');

// Drives most of the public API through one session: mailbox management, APPEND, STATUS, FETCH of
// structure and parts, download() and downloadMany(), flags, SEARCH, COPY, MOVE, EXPUNGE and QUOTA.
// What each call returned is recorded in result.tour for the test to check.
export const runTour = async (client: ImapFlow, result: ScenarioResult): Promise<void> => {
    const tour: Record<string, any> = (result.tour = {});
    const step = (name: string, value: unknown) => {
        tour[name] = value;
        result.steps.push(name);
    };

    step('create', await client.mailboxCreate(['Tour', 'Sub']));
    step('rename', await client.mailboxRename(['Tour', 'Sub'], ['Tour', 'Box']));
    const path = (tour.rename as { newPath: string }).newPath;
    step('subscribe', await client.mailboxSubscribe(path));
    const tree = await client.listTree();
    step(
        'listTree',
        (tree.folders || []).map(folder => folder.path)
    );
    const list = await client.list({ statusQuery: { messages: true } });
    step(
        'list',
        list.map(entry => ({ path: entry.path, specialUse: entry.specialUse, subscribed: entry.subscribed }))
    );

    const appended = [];
    for (const subject of ['tour one', 'tour two', 'tour three']) {
        const response = await client.append(path, tourMessage(subject), ['\\Seen', '$Tour']);
        appended.push(response ? response.uid : null);
    }
    step('append', appended);
    step('status', await client.status(path, { messages: true, unseen: true, uidNext: true }));

    const lock = await client.getMailboxLock(path);
    try {
        const messages = await client.fetchAll('1:*', { uid: true, flags: true, envelope: true, bodyStructure: true, headers: ['subject'] });
        step(
            'fetchAll',
            messages.map(message => ({
                uid: message.uid,
                subject: message.envelope?.subject,
                flags: Array.from(message.flags || []).sort(),
                parts: (message.bodyStructure?.childNodes || []).map(node => node.part + ':' + node.type),
                headers: message.headers?.toString().trim()
            }))
        );
        const first = messages[0]!.uid;
        const second = messages[1]!.uid;
        const third = messages[2]!.uid;

        const one = await client.fetchOne(String(first), { bodyParts: ['1', '2'] }, { uid: true });
        step('fetchOne', one && one.bodyParts ? { text: one.bodyParts.get('1')?.toString().trim(), attachmentBytes: one.bodyParts.get('2')?.length } : false);

        const { meta, content } = await client.download(String(first), '2', { uid: true });
        const chunks: Buffer[] = [];
        for await (const chunk of content || []) {
            chunks.push(chunk);
        }
        step('download', { filename: meta?.filename, contentType: meta?.contentType, matches: Buffer.concat(chunks).toString() === TOUR_ATTACHMENT });
        const many = await client.downloadMany(String(second), ['1', '2'], { uid: true });
        step('downloadMany', { text: many['1']?.content?.toString().trim(), attachment: many['2']?.content?.toString() === TOUR_ATTACHMENT });

        await client.messageFlagsAdd(String(first), ['\\Flagged'], { uid: true });
        await client.messageFlagsRemove(String(second), ['\\Seen'], { uid: true });
        await client.messageFlagsSet(String(third), ['$Only'], { uid: true });
        const flags = await client.fetchAll('1:*', { uid: true, flags: true });
        step(
            'flags',
            flags.map(message => Array.from(message.flags || []).sort())
        );

        step('search', {
            flagged: await client.search({ flagged: true }, { uid: true }),
            unseen: await client.search({ seen: false }, { uid: true }),
            keyword: await client.search({ keyword: '$Only' }, { uid: true }),
            subject: await client.search({ subject: 'two' }, { uid: true }),
            or: await client.search({ or: [{ flagged: true }, { keyword: '$Only' }] }, { uid: true })
        });

        const copied = await client.messageCopy(String(first), 'INBOX', { uid: true });
        step('copy', copied ? { destination: copied.destination, mapped: copied.uidMap ? copied.uidMap.size : 0 } : false);
        const moved = await client.messageMove(String(second), 'Archive', { uid: true });
        step('move', moved ? { destination: moved.destination, mapped: moved.uidMap ? moved.uidMap.size : 0 } : false);
        await client.messageDelete(String(third), { uid: true });
        step('delete', client.mailbox ? client.mailbox.exists : -1);
    } finally {
        lock.release();
    }

    const quota = await client.getQuota('INBOX');
    step('quota', quota ? { path: quota.path } : false);
    step(
        'deleteMailbox',
        [await client.mailboxDelete(path), await client.mailboxDelete('Tour')].map(entry => entry.path)
    );
};

// The default session: LIST, SELECT, APPEND, FETCH, SEARCH, then download() and IDLE if asked
const runSession = async (client: ImapFlow, scenario: Scenario, result: ScenarioResult): Promise<void> => {
    const list = await client.list();
    result.list = list.map(entry => entry.path);
    result.steps.push('list');

    const path = scenario.mailbox || 'INBOX';
    const lock = await client.getMailboxLock(path);
    try {
        result.steps.push('lock');
        if (scenario.append) {
            const appended = await client.append(path, messageSource(scenario)!, ['\\Seen']);
            result.appended = appended ? { uid: appended.uid, seq: appended.seq } : false;
            result.steps.push('append');
        }
        const mailbox = client.mailbox;
        result.mailbox = mailbox ? { path: mailbox.path, exists: mailbox.exists, uidValidity: String(mailbox.uidValidity) } : null;

        result.messages = [];
        if (mailbox && mailbox.exists) {
            for await (const message of client.fetch({ all: true }, { uid: true, envelope: true, size: true, flags: true, source: { maxLength: 40 } })) {
                result.messages.push({
                    uid: message.uid,
                    subject: message.envelope?.subject,
                    size: message.size,
                    flags: Array.from(message.flags || []),
                    source: message.source ? message.source.toString() : undefined
                });
            }
        }
        result.steps.push('fetch');

        result.search = await client.search({ seen: true }, { uid: true });
        result.steps.push('search');

        if (scenario.download && result.appended && result.appended.uid) {
            const { content } = await client.download(String(result.appended.uid), undefined, { uid: true });
            let size = 0;
            for await (const chunk of content || []) {
                size += chunk.length;
            }
            result.downloaded = size;
            result.steps.push('download');
        }

        if (scenario.idle) {
            // idle() returns once IDLE has been broken, which the NOOP below does through
            // the connection's preCheck; the EXISTS the server pushes meanwhile is what
            // the session was idling for
            const exists = new Promise<{ count: number; prevCount: number }>(resolve => client.once('exists', event => resolve(event)));
            const idling = client.idle();
            const event = await exists;
            await client.noop();
            await idling;
            result.idle = { count: event.count, prevCount: event.prevCount, existsAfter: client.mailbox ? client.mailbox.exists : -1 };
            result.steps.push('idle');
        }
    } finally {
        lock.release();
    }
};

export const runScenario = async (scenario: Scenario): Promise<ScenarioResult> => {
    const result: ScenarioResult = { ok: false, steps: [], logs: [] };
    const client = createClient(scenario, result);
    try {
        try {
            await client.connect();
        } finally {
            // Recorded even when connect() fails, so a scenario without credentials still
            // reports whether the STARTTLS upgrade happened before authentication stopped it
            result.secureConnection = client.secureConnection;
            result.capabilities = Array.from(client.capabilities.keys());
            result.greeting = client.greeting;
            result.tls = client.tls;
        }
        result.steps.push('connect');
        // COMPRESS is active once the DEFLATE stream exists, an internal member that the
        // shipped declarations strip
        result.compressed = !!(client as unknown as { _deflate?: unknown })._deflate;
        await (scenario.tour ? runTour(client, result) : runSession(client, scenario, result));

        result.stats = client.stats();
        await client.logout();
        result.steps.push('logout');
        result.ok = true;
    } catch (err: any) {
        result.error = { message: err.message, code: err.code, tlsFailed: err.tlsFailed };
        client.close();
    }
    return result;
};

export default {
    async fetch(request: Request): Promise<Response> {
        if (request.method !== 'POST') {
            return new Response('POST a scenario', { status: 405 });
        }
        return Response.json(await runScenario((await request.json()) as Scenario));
    }
};
