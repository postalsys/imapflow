// The API tour: one session that drives most of the public API (mailbox management, APPEND,
// STATUS, FETCH of structure and parts, download() and downloadMany(), flags, SEARCH, COPY, MOVE,
// EXPUNGE and QUOTA) against ImapKit with every plugin. Runtime neutral, so the Workers and celld
// harnesses and the browser page run the same session; test/cloudflare/tour.ts checks the result.
//
// Imports only the ImapFlow type: each runtime passes a client of the build it loads.

import type { ImapFlow } from '../../src/imap-flow.js';

// The methods the tour calls. A Pick, so a client of the built output (whose declarations leave
// out the internal members) fits as well
export type TourClient = Pick<
    ImapFlow,
    | 'mailboxCreate'
    | 'mailboxRename'
    | 'mailboxSubscribe'
    | 'mailboxDelete'
    | 'listTree'
    | 'list'
    | 'append'
    | 'status'
    | 'getMailboxLock'
    | 'fetchAll'
    | 'fetchOne'
    | 'download'
    | 'downloadMany'
    | 'messageFlagsAdd'
    | 'messageFlagsRemove'
    | 'messageFlagsSet'
    | 'search'
    | 'messageCopy'
    | 'messageMove'
    | 'messageDelete'
    | 'mailbox'
    | 'getQuota'
>;

export interface TourResult {
    steps: string[];
    /** What each step of the tour returned */
    tour?: Record<string, unknown> | undefined;
}

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
export const runTour = async (client: TourClient, result: TourResult): Promise<void> => {
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
                id: message.id,
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
