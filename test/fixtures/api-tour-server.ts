// The Node.js side of the API tour (test/fixtures/api-tour.ts): the ImapKit server it runs
// against, started in the test process, and the checks of what it reported. Shared by the
// Workers, celld and browser harnesses.

import assert from 'node:assert/strict';
import imapkit from 'imapkit';
import { ALL_PLUGINS, DEFAULT_STORAGE } from './imapkit-config.js';
import { listen } from './scripted-server.js';
import type { Scenario, ScenarioResult } from '../cloudflare/worker.js';
import type { TourResult } from './api-tour.js';

export interface TourServer {
    scenario: Scenario;
    /** Commands ImapKit answered with BAD, client input it found broken */
    bad: string[];
    close(): Promise<void>;
}

// The error and the log of a scenario, as an assertion message
export const details = (result: Pick<ScenarioResult, 'error' | 'logs'>): string => JSON.stringify(result.error) + '\n' + result.logs.join('\n');

export const startTourServer = async (extra: Partial<Scenario> = {}): Promise<TourServer> => {
    const server = imapkit({
        plugins: ALL_PLUGINS,
        storage: DEFAULT_STORAGE
    });
    const bad: string[] = [];
    server.on('command', (event: { command: string; status: string }) => {
        if (event.status === 'BAD') {
            bad.push(event.command);
        }
    });
    const port = await listen(server);
    return {
        scenario: {
            host: '127.0.0.1',
            port,
            secure: false,
            // ImapKit offers STARTTLS with a self-signed certificate, which these runtimes reject
            doSTARTTLS: false,
            auth: { user: 'testuser', pass: 'testpass' },
            tour: true,
            ...extra
        },
        bad,
        close: () => new Promise<void>(resolve => server.close(() => resolve()))
    };
};

export const assertTour = (result: TourResult & Pick<ScenarioResult, 'ok' | 'error' | 'logs'>): void => {
    assert.equal(result.ok, true, details(result));
    assert.deepEqual(result.steps, [
        'connect',
        'create',
        'rename',
        'subscribe',
        'listTree',
        'list',
        'append',
        'status',
        'fetchAll',
        'fetchOne',
        'download',
        'downloadMany',
        'flags',
        'search',
        'copy',
        'move',
        'delete',
        'quota',
        'deleteMailbox',
        'logout'
    ]);
    const tour = result.tour as Record<string, any>;
    assert.equal(tour.create.path, 'Tour/Sub');
    assert.equal(tour.create.created, true);
    assert.deepEqual(tour.rename, { path: 'Tour/Sub', newPath: 'Tour/Box' });
    assert.equal(tour.subscribe, true);
    assert.ok(tour.listTree.includes('Tour'));
    assert.deepEqual(
        tour.list.find((entry: any) => entry.path === 'Archive'),
        { path: 'Archive', specialUse: '\\Archive', subscribed: true }
    );
    assert.ok(tour.list.some((entry: any) => entry.path === 'Tour/Box' && entry.subscribed));

    assert.equal(tour.append.length, 3);
    assert.ok(
        tour.append.every((uid: unknown) => typeof uid === 'number'),
        'APPENDUID reported every UID'
    );
    assert.equal(tour.status.messages, 3);
    assert.equal(tour.status.unseen, 0);
    assert.equal(tour.status.uidNext, tour.append[2] + 1);

    assert.deepEqual(
        tour.fetchAll.map((message: any) => message.subject),
        ['tour one', 'tour two', 'tour three']
    );
    for (const message of tour.fetchAll) {
        assert.ok(typeof message.id === 'string' && message.id.length > 0, 'the message got an id');
        assert.deepEqual(message.flags, ['$Tour', '\\Seen']);
        assert.deepEqual(message.parts, ['1:text/plain', '2:application/octet-stream']);
        assert.equal(message.headers, `Subject: ${message.subject}`);
    }
    assert.deepEqual(tour.fetchOne, { text: 'Body of tour one', attachmentBytes: tour.fetchOne.attachmentBytes });
    assert.ok(tour.fetchOne.attachmentBytes > 0);
    assert.deepEqual(tour.download, { filename: 'data.bin', contentType: 'application/octet-stream', matches: true });
    assert.deepEqual(tour.downloadMany, { text: 'Body of tour two', attachment: true });

    const [first, second, third] = tour.append;
    assert.deepEqual(tour.flags, [['$Tour', '\\Flagged', '\\Seen'], ['$Tour'], ['$Only']]);
    assert.deepEqual(tour.search, {
        flagged: [first],
        unseen: [second, third],
        keyword: [third],
        subject: [second],
        or: [first, third]
    });

    assert.deepEqual(tour.copy, { destination: 'INBOX', mapped: 1 });
    assert.deepEqual(tour.move, { destination: 'Archive', mapped: 1 });
    assert.equal(tour.delete, 1, 'only the copied message is left after MOVE and the EXPUNGE');
    assert.equal(tour.quota.path, 'INBOX', 'GETQUOTAROOT was answered');
    assert.deepEqual(tour.deleteMailbox, ['Tour/Box', 'Tour']);
};
