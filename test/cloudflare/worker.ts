// A Cloudflare Worker that drives an ImapFlow session against the server named in the
// request body and reports what it saw. Run by test/cloudflare/cloudflare-test.ts under
// workerd through `wrangler dev`, so the ES module build is exercised on the Workers
// runtime with nodejs_compat rather than on Node.js.
//
// Imports the built ES module output on purpose: that is what an installed copy of the
// package loads. The file is excluded from the project type-check for the same reason, the
// declarations next to the build only exist once `npm run build` has run.

import { ImapFlow } from '../../dist/esm/imap-flow.js';

export interface Scenario {
    host: string;
    port: number;
    secure?: boolean | undefined;
    doSTARTTLS?: boolean | undefined;
    /** Credentials. Without them connect() stops right after the STARTTLS negotiation */
    auth?: { user: string; pass: string } | undefined;
    tls?: { rejectUnauthorized?: boolean | undefined } | undefined;
    mailbox?: string | undefined;
    /** A message to APPEND before fetching */
    append?: string | undefined;
    /** Use the default (pino) logger instead of turning logging off */
    defaultLogger?: boolean | undefined;
    logRaw?: boolean | undefined;
    socketTimeout?: number | undefined;
    disableCompression?: boolean | undefined;
    /** Enter IDLE after fetching and wait for the server to announce a new message */
    idle?: boolean | undefined;
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
    stats?: { sent: number; received: number } | undefined;
    logs: string[];
}

export default {
    async fetch(request: Request): Promise<Response> {
        if (request.method !== 'POST') {
            return new Response('POST a scenario', { status: 405 });
        }
        const scenario = (await request.json()) as Scenario;
        const result: ScenarioResult = { ok: false, steps: [], logs: [] };
        const client = new ImapFlow({
            host: scenario.host,
            port: scenario.port,
            secure: !!scenario.secure,
            doSTARTTLS: scenario.doSTARTTLS,
            auth: scenario.auth,
            tls: scenario.tls,
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
            result.compressed = !!client._deflate;

            const list = await client.list();
            result.list = list.map(entry => entry.path);
            result.steps.push('list');

            const path = scenario.mailbox || 'INBOX';
            const lock = await client.getMailboxLock(path);
            try {
                result.steps.push('lock');
                if (scenario.append) {
                    const appended = await client.append(path, scenario.append, ['\\Seen']);
                    result.appended = appended ? { uid: appended.uid, seq: appended.seq } : false;
                    result.steps.push('append');
                }
                const mailbox = client.mailbox;
                result.mailbox = mailbox ? { path: mailbox.path, exists: mailbox.exists, uidValidity: String(mailbox.uidValidity) } : null;

                result.messages = [];
                if (mailbox && mailbox.exists) {
                    for await (const message of client.fetch(
                        { all: true },
                        { uid: true, envelope: true, size: true, flags: true, source: { maxLength: 40 } }
                    )) {
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

            result.stats = client.stats();
            await client.logout();
            result.steps.push('logout');
            result.ok = true;
        } catch (err: any) {
            result.error = { message: err.message, code: err.code, tlsFailed: err.tlsFailed };
            client.close();
        }
        return Response.json(result);
    }
};
