import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ImapFlow } from '../src/imap-flow.js';

// Unit tests that exercise ImapFlow public/command methods against a real
// ImapFlow instance with `run` (and occasionally lower-level helpers) stubbed.
// This deterministically covers the thin command wrappers, range resolution,
// the untagged response handlers, and the fetch/download orchestration without
// requiring a live IMAP server.

// Build a real ImapFlow instance with logging disabled and a selected mailbox.
// `run` is stubbed by default to record calls and return a configurable value.
const makeClient = (overrides = {}) => {
    let client: any = new ImapFlow({
        host: 'imap.example.com',
        port: 993,
        auth: { user: 'test', pass: 'test' },
        logger: false,
        ...overrides
    });
    client.socket = { destroyed: false, destroy: () => {} };
    client.usable = true;
    client.mailbox = {
        path: 'INBOX',
        exists: 10,
        flags: new Set(['\\Seen', '\\Flagged']),
        permanentFlags: new Set(['\\*'])
    };
    client.state = client.states.SELECTED;
    return client;
};

// Records every run() invocation so assertions can verify the dispatched command.
const recordRun: any = (client: any, returnValue: any) => {
    let calls: any = [];
    client.run = async (...args: any[]) => {
        calls.push(args);
        return typeof returnValue === 'function' ? returnValue(...args) : returnValue;
    };
    return calls;
};

describe('imap-flow-methods', () => {
    // ============================================================================
    // Thin command wrappers
    // ============================================================================
    it('Methods: getQuota defaults path to INBOX', async () => {
        let client = makeClient();
        let calls = recordRun(client, { path: 'INBOX' });
        let res = await client.getQuota();
        assert.deepEqual(calls[0], ['QUOTA', 'INBOX']);
        assert.deepEqual(res, { path: 'INBOX' });
    });
    it('Methods: getQuota uses given path', async () => {
        let client = makeClient();
        let calls = recordRun(client, false);
        await client.getQuota('Archive');
        assert.deepEqual(calls[0], ['QUOTA', 'Archive']);
    });
    it('Methods: list builds folders map', async () => {
        let client = makeClient();
        recordRun(client, [
            { path: 'INBOX', name: 'INBOX' },
            { path: 'Sent', name: 'Sent' }
        ]);
        let folders = await client.list();
        assert.equal(folders.length, 2);
        assert.ok(client.folders instanceof Map);
        assert.equal(client.folders.get('Sent').name, 'Sent');
    });
    it('Methods: list passes options', async () => {
        let client = makeClient();
        let calls = recordRun(client, []);
        await client.list({ statusQuery: { messages: true } });
        assert.deepEqual(calls[0][0], 'LIST');
        assert.deepEqual(calls[0][3], { statusQuery: { messages: true } });
    });
    it('Methods: listTree returns tree structure', async () => {
        let client = makeClient();
        recordRun(client, [
            { path: 'INBOX', name: 'INBOX', delimiter: '/', parent: [], flags: new Set() },
            { path: 'INBOX/Sub', name: 'Sub', delimiter: '/', parent: ['INBOX'], flags: new Set() }
        ]);
        let tree = await client.listTree();
        assert.ok(tree);
        assert.ok(Array.isArray(tree.folders));
        assert.ok(client.folders instanceof Map);
    });
    it('Methods: listTree passes through inline status objects', async () => {
        let client = makeClient();
        recordRun(client, [
            { path: 'INBOX', name: 'INBOX', delimiter: '/', parent: [], flags: new Set(), status: { path: 'INBOX', messages: 5, unseen: 2 } },
            { path: 'INBOX/Sub', name: 'Sub', delimiter: '/', parent: ['INBOX'], flags: new Set() }
        ]);
        let tree: any = await client.listTree({ statusQuery: { messages: true, unseen: true } });
        // The StatusObject must survive into the tree node - it used to be coerced
        // into a boolean by the tree builder
        assert.deepEqual(tree.folders[0].status, { path: 'INBOX', messages: 5, unseen: 2 });
    });
    it('Methods: noop dispatches NOOP', async () => {
        let client = makeClient();
        let calls = recordRun(client, true);
        await client.noop();
        assert.deepEqual(calls[0], ['NOOP']);
    });
    it('Methods: mailboxCreate dispatches CREATE', async () => {
        let client = makeClient();
        let calls = recordRun(client, { path: 'New', created: true });
        let res = await client.mailboxCreate(['parent', 'child']);
        assert.deepEqual(calls[0], ['CREATE', ['parent', 'child']]);
        assert.equal(res.created, true);
    });
    it('Methods: mailboxRename dispatches RENAME', async () => {
        let client = makeClient();
        let calls = recordRun(client, { path: 'a', newPath: 'b' });
        await client.mailboxRename('a', 'b');
        assert.deepEqual(calls[0], ['RENAME', 'a', 'b']);
    });
    it('Methods: mailboxDelete dispatches DELETE', async () => {
        let client = makeClient();
        let calls = recordRun(client, { path: 'a' });
        await client.mailboxDelete('a');
        assert.deepEqual(calls[0], ['DELETE', 'a']);
    });
    it('Methods: mailboxSubscribe dispatches SUBSCRIBE', async () => {
        let client = makeClient();
        let calls = recordRun(client, true);
        await client.mailboxSubscribe('a');
        assert.deepEqual(calls[0], ['SUBSCRIBE', 'a']);
    });
    it('Methods: mailboxUnsubscribe dispatches UNSUBSCRIBE', async () => {
        let client = makeClient();
        let calls = recordRun(client, true);
        await client.mailboxUnsubscribe('a');
        assert.deepEqual(calls[0], ['UNSUBSCRIBE', 'a']);
    });
    it('Methods: mailboxOpen dispatches SELECT', async () => {
        let client = makeClient();
        let calls = recordRun(client, { path: 'INBOX' });
        await client.mailboxOpen('INBOX', { readOnly: true });
        assert.deepEqual(calls[0], ['SELECT', 'INBOX', { readOnly: true }]);
    });
    it('Methods: mailboxClose dispatches CLOSE', async () => {
        let client = makeClient();
        let calls = recordRun(client, true);
        await client.mailboxClose();
        assert.deepEqual(calls[0], ['CLOSE']);
    });
    it('Methods: status dispatches STATUS', async () => {
        let client = makeClient();
        let calls = recordRun(client, { path: 'INBOX', unseen: 3 });
        let res = await client.status('INBOX', { unseen: true });
        assert.deepEqual(calls[0], ['STATUS', 'INBOX', { unseen: true }]);
        assert.equal(res.unseen, 3);
    });

    // ============================================================================
    // idle()
    // ============================================================================
    it('Methods: idle runs IDLE when not already idling', async () => {
        let client = makeClient();
        let calls = recordRun(client, true);
        await client.idle();
        assert.deepEqual(calls[0], ['IDLE', client.maxIdleTime]);
    });
    it('Methods: idle is a no-op when already idling', async () => {
        let client = makeClient();
        client.idling = true;
        let calls = recordRun(client, true);
        let res = await client.idle();
        assert.equal(calls.length, 0);
        assert.equal(res, undefined);
    });

    // ============================================================================
    // Flag operations + range resolution
    // ============================================================================
    it('Methods: messageFlagsSet resolves range and dispatches STORE', async () => {
        let client = makeClient();
        let calls = recordRun(client, true);
        let res = await client.messageFlagsSet('1:5', ['\\Seen'], { uid: true });
        assert.equal(res, true);
        assert.equal(calls[0][0], 'STORE');
        assert.equal(calls[0][1], '1:5');
        assert.deepEqual(calls[0][3], { operation: 'set', uid: true });
    });
    it('Methods: messageFlagsSet works without an options argument', async () => {
        let client = makeClient();
        let calls = recordRun(client, true);
        let res = await client.messageFlagsSet('1', ['\\Seen']); // no options -> options || {}
        assert.equal(res, true);
        assert.equal(calls[0][0], 'STORE');
    });
    it('Methods: search derivation handles non-string returnOptions entries', async () => {
        let client = makeClient();
        recordRun(client, [1, 2, 3]); // no ESEARCH -> client-side derivation runs
        // a non-string returnOption (object) is passed through untouched by the mapper
        let res: any = await client.search({ all: true }, { returnOptions: ['count', { partial: '1:2' }] });
        assert.equal((res as any).count, 3);
    });
    it('Methods: messageFlagsSet returns false for empty range', async () => {
        let client = makeClient();
        let calls = recordRun(client, true);
        let res = await client.messageFlagsSet([], ['\\Seen'], {});
        assert.equal(res, false);
        assert.equal(calls.length, 0);
    });
    it('Methods: messageFlagsAdd dispatches STORE add', async () => {
        let client = makeClient();
        let calls = recordRun(client, true);
        await client.messageFlagsAdd('1', ['\\Flagged']);
        assert.equal(calls[0][3].operation, 'add');
    });
    it('Methods: messageFlagsAdd returns false on empty range', async () => {
        let client = makeClient();
        recordRun(client, true);
        let res = await client.messageFlagsAdd([], ['\\Flagged']);
        assert.equal(res, false);
    });
    it('Methods: messageFlagsRemove dispatches STORE remove', async () => {
        let client = makeClient();
        let calls = recordRun(client, true);
        await client.messageFlagsRemove('1', ['\\Flagged']);
        assert.equal(calls[0][3].operation, 'remove');
    });
    it('Methods: messageFlagsRemove returns false on empty range', async () => {
        let client = makeClient();
        recordRun(client, true);
        let res = await client.messageFlagsRemove([], ['\\Flagged']);
        assert.equal(res, false);
    });
    it('Methods: setFlagColor returns false for empty range', async () => {
        let client = makeClient();
        recordRun(client, true);
        let res = await client.setFlagColor([], 'red');
        assert.equal(res, false);
    });
    it('Methods: setFlagColor returns false for invalid color', async () => {
        let client = makeClient();
        recordRun(client, true);
        let res = await client.setFlagColor('1', 'not-a-color');
        assert.equal(res, false);
    });
    it('Methods: setFlagColor red issues add and remove STORE', async () => {
        let client = makeClient();
        let calls = recordRun(client, true);
        // red sets \\Flagged and clears the MailFlagBit* keywords -> both add and remove
        let res = await client.setFlagColor('1:*', 'red');
        assert.ok(res);
        let ops = calls.map((c: any) => c[3].operation);
        assert.ok(ops.includes('add'));
        assert.ok(ops.includes('remove'));
    });
    it('Methods: setFlagColor removal (null color) issues only a remove STORE', async () => {
        let client = makeClient();
        let calls = recordRun(client, true);
        // A null/empty color clears the color: getColorFlags returns an empty add set and a
        // non-empty remove set, so the add STORE is skipped and only the remove STORE runs.
        let res = await client.setFlagColor('1', null as any);
        assert.ok(res);
        assert.equal(calls.length, 1);
        assert.equal(calls[0][0], 'STORE');
        assert.equal(calls[0][3].operation, 'remove');
        assert.deepEqual(calls[0][2], ['\\Flagged', '$MailFlagBit0', '$MailFlagBit1', '$MailFlagBit2']);
    });
    it('Methods: messageDelete resolves range and dispatches EXPUNGE', async () => {
        let client = makeClient();
        let calls = recordRun(client, true);
        let res = await client.messageDelete('1:3', { uid: true });
        assert.equal(res, true);
        assert.equal(calls[0][0], 'EXPUNGE');
        assert.equal(calls[0][1], '1:3');
    });
    it('Methods: messageDelete returns false on empty range', async () => {
        let client = makeClient();
        recordRun(client, true);
        let res = await client.messageDelete([]);
        assert.equal(res, false);
    });

    // ============================================================================
    // append / copy / move
    // ============================================================================
    it('Methods: append dispatches APPEND', async () => {
        let client = makeClient();
        let calls = recordRun(client, { destination: 'INBOX', uid: 5 });
        let res: any = await client.append('INBOX', 'raw message', ['\\Seen'], new Date(2020, 1, 1));
        assert.equal(calls[0][0], 'APPEND');
        assert.equal(res.uid, 5);
    });
    it('Methods: append returns false when run returns falsy', async () => {
        let client = makeClient();
        recordRun(client, false);
        let res = await client.append('INBOX', 'raw');
        assert.equal(res, false);
    });
    it('Methods: messageCopy resolves range and dispatches COPY', async () => {
        let client = makeClient();
        let calls = recordRun(client, { destination: 'Backup' });
        await client.messageCopy('1:*', 'Backup', { uid: false });
        assert.equal(calls[0][0], 'COPY');
        assert.equal(calls[0][2], 'Backup');
    });
    it('Methods: messageCopy returns false on empty range', async () => {
        let client = makeClient();
        recordRun(client, true);
        let res = await client.messageCopy([], 'Backup');
        assert.equal(res, false);
    });
    it('Methods: messageMove resolves range and dispatches MOVE', async () => {
        let client = makeClient();
        let calls = recordRun(client, { destination: 'Trash' });
        await client.messageMove('1', 'Trash');
        assert.equal(calls[0][0], 'MOVE');
        assert.equal(calls[0][2], 'Trash');
    });
    it('Methods: messageMove returns false on empty range', async () => {
        let client = makeClient();
        recordRun(client, true);
        let res = await client.messageMove([], 'Trash');
        assert.equal(res, false);
    });

    // ============================================================================
    // resolveRange branches
    // ============================================================================
    it('Methods: resolveRange converts number', async () => {
        let client = makeClient();
        let res = await client.resolveRange(5, {});
        assert.equal(res, '5');
    });
    it('Methods: resolveRange converts bigint', async () => {
        let client = makeClient();
        let res = await client.resolveRange(BigInt(7), {});
        assert.equal(res, '7');
    });
    it('Methods: resolveRange star uses mailbox.exists', async () => {
        let client = makeClient();
        let options: any = {};
        let res = await client.resolveRange('*', options);
        assert.equal(res, '10');
        assert.equal(options.uid, false);
    });
    it('Methods: resolveRange star returns false on empty mailbox', async () => {
        let client = makeClient();
        client.mailbox.exists = 0;
        let res = await client.resolveRange('*', {});
        assert.equal(res, false);
    });
    it('Methods: resolveRange all:true => 1:*', async () => {
        let client = makeClient();
        let res = await client.resolveRange({ all: true }, {});
        assert.equal(res, '1:*');
    });
    it('Methods: resolveRange uid object', async () => {
        let client = makeClient();
        let options: any = {};
        let res = await client.resolveRange({ uid: '100:200' }, options);
        assert.equal(res, '100:200');
        assert.equal(options.uid, true);
    });
    it('Methods: resolveRange search query runs SEARCH and packs', async () => {
        let client = makeClient();
        let options = {};
        client.run = async (cmd: any, query: any, opts: any) => {
            assert.equal(cmd, 'SEARCH');
            assert.equal(opts.uid, true);
            return [1, 2, 3, 5];
        };
        let res = await client.resolveRange({ seen: false }, options);
        assert.equal(res, '1:3,5');
    });
    it('Methods: resolveRange search query with no hits', async () => {
        let client = makeClient();
        client.run = async () => [];
        let res = await client.resolveRange({ seen: false }, {});
        assert.equal(res, false);
    });
    it('Methods: resolveRange array joins with commas', async () => {
        let client = makeClient();
        let res = await client.resolveRange([1, 2, 4], {});
        assert.equal(res, '1,2,4');
    });
    it('Methods: resolveRange empty string returns false', async () => {
        let client = makeClient();
        let res = await client.resolveRange('', {});
        assert.equal(res, false);
    });

    // ============================================================================
    // ensureSelectedMailbox
    // ============================================================================
    it('Methods: ensureSelectedMailbox returns false without path', async () => {
        let client = makeClient();
        let res = await client.ensureSelectedMailbox(null as any);
        assert.equal(res, false);
    });
    it('Methods: ensureSelectedMailbox returns true when already selected', async () => {
        let client = makeClient();
        let res = await client.ensureSelectedMailbox('INBOX');
        assert.equal(res, true);
    });
    it('Methods: ensureSelectedMailbox opens a different mailbox', async () => {
        let client = makeClient();
        let calls = recordRun(client, { path: 'Other' });
        await client.ensureSelectedMailbox('Other');
        assert.equal(calls[0][0], 'SELECT');
        assert.equal(calls[0][1], 'Other');
    });

    // ============================================================================
    // search()
    // ============================================================================
    it('Methods: search returns undefined without mailbox', async () => {
        let client = makeClient();
        client.mailbox = false;
        let res = await client.search({ seen: false });
        assert.equal(res, undefined);
    });
    it('Methods: search returns server result', async () => {
        let client = makeClient();
        recordRun(client, [1, 2, 3]);
        let res = await client.search({ seen: false });
        assert.deepEqual(res, [1, 2, 3]);
    });
    it('Methods: search returns false when run returns falsy', async () => {
        let client = makeClient();
        recordRun(client, null);
        let res = await client.search({ all: true });
        assert.equal(res, false);
    });
    it('Methods: search derives ESearch COUNT/MIN/MAX/ALL client-side', async () => {
        let client = makeClient();
        recordRun(client, [2, 4, 6, 8]);
        let res: any = await client.search({ all: true }, { returnOptions: ['count', 'min', 'max', 'all'] });
        assert.equal((res as any).count, 4);
        assert.equal((res as any)!.min, 2);
        assert.equal((res as any)!.max, 8);
        assert.equal((res as any)!.all, '2,4,6,8');
    });
    it('Methods: search returnOptions PARTIAL only returns raw array', async () => {
        let client = makeClient();
        recordRun(client, [1, 2, 3]);
        let res = await client.search({ all: true }, { returnOptions: ['partial'] } as any);
        assert.deepEqual(res, [1, 2, 3]);
    });

    // ============================================================================
    // Untagged response handlers
    // ============================================================================
    it('Methods: untaggedExists ignores when no mailbox', async () => {
        let client = makeClient();
        client.mailbox = false;
        await client.untaggedExists({ command: '12' });
        assert.ok(true);
    });
    it('Methods: untaggedExists ignores invalid command', async () => {
        let client = makeClient();
        let fired = false;
        client.on('exists', () => {
            fired = true;
        });
        await client.untaggedExists({ command: 'NaNvalue' });
        assert.equal(fired, false);
    });
    it('Methods: untaggedExists no-op when count unchanged', async () => {
        let client = makeClient();
        client.mailbox.exists = 10;
        let fired = false;
        client.on('exists', () => {
            fired = true;
        });
        await client.untaggedExists({ command: '10' });
        assert.equal(fired, false);
    });
    it('Methods: untaggedExists emits exists event on change', async () => {
        let client = makeClient();
        client.mailbox.exists = 10;
        let evt: any = null;
        client.on('exists', (e: any) => {
            evt = e;
        });
        await client.untaggedExists({ command: '12' });
        assert.ok(evt);
        assert.equal(evt.count, 12);
        assert.equal((evt as any).prevCount, 10);
        assert.equal((client.mailbox as any).exists, 12);
    });
    it('Methods: untaggedExpunge ignores when no mailbox', async () => {
        let client = makeClient();
        client.mailbox = false;
        await client.untaggedExpunge({ command: '2' });
        assert.ok(true);
    });
    it('Methods: untaggedExpunge ignores invalid command', async () => {
        let client = makeClient();
        let fired = false;
        client.on('expunge', () => {
            fired = true;
        });
        await client.untaggedExpunge({ command: 'x' });
        assert.equal(fired, false);
    });
    it('Methods: untaggedExpunge emits expunge event', async () => {
        let client = makeClient();
        client.mailbox.exists = 10;
        let evt: any = null;
        client.on('expunge', (e: any) => {
            evt = e;
        });
        await client.untaggedExpunge({ command: '3' });
        assert.ok(evt);
        assert.equal(evt.seq, 3);
        assert.equal((evt as any).vanished, false);
        assert.equal((client.mailbox as any).exists, 9);
    });
    it('Methods: untaggedExpunge uses expungeHandler when set', async () => {
        let payloads: any = [];
        let client = makeClient({ expungeHandler: async (payload: any) => payloads.push(payload) });
        client.mailbox.exists = 5;
        await client.untaggedExpunge({ command: '2' });
        assert.equal(payloads.length, 1);
        assert.equal(payloads[0].seq, 2);
    });
    it('Methods: untaggedExpunge handles expungeHandler error', async () => {
        let client = makeClient({
            expungeHandler: async () => {
                throw new Error('handler boom');
            }
        });
        client.mailbox.exists = 5;
        // Should not throw despite handler error
        await client.untaggedExpunge({ command: '2' });
        assert.ok(true);
    });
    it('Methods: untaggedVanished ignores when no mailbox', async () => {
        let client = makeClient();
        client.mailbox = false;
        await client.untaggedVanished({ attributes: [{ value: '1:3' }] } as any);
        assert.ok(true);
    });
    it('Methods: untaggedVanished emits expunge per uid', async () => {
        let client = makeClient();
        let events: any = [];
        client.on('expunge', (e: any) => events.push(e));
        await client.untaggedVanished({ attributes: [{ value: '1:3' }] } as any);
        assert.equal(events.length, 3);
        assert.equal(events[0].uid, 1);
        assert.equal(events[0].vanished, true);
        assert.equal(events[0].earlier, false);
    });
    it('Methods: untaggedVanished EARLIER tag sets earlier flag', async () => {
        let client = makeClient();
        let events: any = [];
        client.on('expunge', (e: any) => events.push(e));
        await client.untaggedVanished({
            attributes: [[{ value: 'EARLIER' }], { value: '5' }]
        } as any);
        assert.equal(events.length, 1);
        assert.equal(events[0].uid, 5);
        assert.equal(events[0].earlier, true);
    });
    it('Methods: untaggedVanished routes through expungeHandler', async () => {
        let payloads: any = [];
        let client = makeClient({ expungeHandler: async (p: any) => payloads.push(p) });
        await client.untaggedVanished({ attributes: [{ value: '7' }] } as any);
        assert.equal(payloads.length, 1);
        assert.equal(payloads[0].uid, 7);
    });
    it('Methods: untaggedVanished swallows expungeHandler error', async () => {
        let client = makeClient({
            expungeHandler: async () => {
                throw new Error('vanished boom');
            }
        });
        await client.untaggedVanished({ attributes: [{ value: '7' }] } as any);
        assert.ok(true);
    });
    it('Methods: untaggedFetch ignores when no mailbox', async () => {
        let client = makeClient();
        client.mailbox = false;
        await client.untaggedFetch({ command: '1', attributes: [] });
        assert.ok(true);
    });
    it('Methods: untaggedFetch emits flags event', async () => {
        let client = makeClient();
        let evt: any = null;
        client.on('flags', (e: any) => {
            evt = e;
        });
        // Build an untagged FETCH with FLAGS and UID attributes
        let untagged = {
            command: '1',
            attributes: [
                { type: 'ATOM', value: 'FETCH' },
                [{ type: 'ATOM', value: 'UID' }, { type: 'ATOM', value: '100' }, { type: 'ATOM', value: 'FLAGS' }, [{ type: 'ATOM', value: '\\Seen' }]]
            ]
        };
        await client.untaggedFetch(untagged);
        assert.ok(evt);
        assert.equal(evt.uid, 100);
        assert.ok((evt as any).flags instanceof Set);
        assert.ok((evt as any).flags.has('\\Seen'));
    });

    // ============================================
    // autoEnable
    // ============================================
    it('Methods: autoEnable requests IMAP4rev2 alongside the base extensions', async () => {
        let client = makeClient();
        let calls = recordRun(client, new Set(['CONDSTORE', 'IMAP4REV2']));
        await client.autoEnable();
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0], ['ENABLE', ['CONDSTORE', 'UTF8=ACCEPT', 'IMAP4rev2']]);
    });
    it('Methods: autoEnable honors disableIMAP4rev2', async () => {
        let client = makeClient({ disableIMAP4rev2: true });
        let calls = recordRun(client, new Set(['CONDSTORE']));
        await client.autoEnable();
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0], ['ENABLE', ['CONDSTORE', 'UTF8=ACCEPT']]);
    });
    it('Methods: autoEnable includes QRESYNC when requested', async () => {
        let client = makeClient({ qresync: true });
        let calls = recordRun(client, new Set(['CONDSTORE', 'QRESYNC', 'IMAP4REV2']));
        await client.autoEnable();
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0], ['ENABLE', ['CONDSTORE', 'UTF8=ACCEPT', 'QRESYNC', 'IMAP4rev2']]);
    });
    it('Methods: autoEnable retries without IMAP4rev2 when the whole command fails', async () => {
        let client = makeClient();
        // RFC 5161 requires unknown ENABLE arguments to be ignored, but a broken
        // server may reject the whole command over IMAP4rev2 - the retry keeps
        // CONDSTORE/UTF8=ACCEPT from being lost as collateral damage
        let calls = recordRun(client, (cmd: any, list: any) => (list.includes('IMAP4rev2') ? false : new Set(['CONDSTORE'])));
        await client.autoEnable();
        assert.equal(calls.length, 2);
        assert.deepEqual(calls[1], ['ENABLE', ['CONDSTORE', 'UTF8=ACCEPT']]);
    });
    it('Methods: autoEnable does not retry when disableIMAP4rev2 already omitted it', async () => {
        let client = makeClient({ disableIMAP4rev2: true });
        let calls = recordRun(client, () => false);
        await client.autoEnable();
        assert.equal(calls.length, 1);
    });
    it('Methods: untaggedExpunge refuses an unusable sequence number', async () => {
        // Same bound untaggedExists() applies: an overflowing or non-decimal value must not
        // decrement the live message count
        let client = makeClient();
        client.mailbox.exists = 10;
        let events: any = [];
        client.on('expunge', (e: any) => events.push(e));

        await client.untaggedExpunge(false as any);
        for (let bad of ['9'.repeat(400), '1e5', '0', 'abc', '']) {
            await client.untaggedExpunge({ command: bad });
        }
        assert.equal((client.mailbox as any).exists, 10, 'the live message count must be left alone');
        assert.equal(events.length, 0);

        await client.untaggedExpunge({ command: '3' });
        assert.equal((client.mailbox as any).exists, 9, 'a usable sequence number is still applied');
        assert.equal(events.length, 1);
        assert.equal(events[0].seq, 3);
    });
    it('Methods: untaggedVanished survives a malformed response', async () => {
        // "* VANISHED (EARLIER)" leaves no sequence set at all. Throwing here would abort the
        // handler for the whole response, and handleResponse only warns - so every expunge the
        // response did carry would be dropped and the client's mailbox view would go stale.
        let client = makeClient();
        let events: any = [];
        client.on('expunge', (e: any) => events.push(e));

        await client.untaggedVanished({ attributes: [[{ value: 'EARLIER' }]] } as any);
        await client.untaggedVanished({ attributes: [] });
        await client.untaggedVanished({});
        await client.untaggedVanished({ attributes: [[{ value: 'EARLIER' }], null] } as any);

        assert.equal(events.length, 0, 'nothing to report, and nothing thrown');

        // a well-formed response still works after the malformed ones
        await client.untaggedVanished({ attributes: [[{ value: 'EARLIER' }], { value: '5:6' }] } as any);
        assert.equal(events.length, 2);
        assert.equal(events[0].uid, 5);
        assert.equal(events[0].earlier, true);
    });
    it('Methods: untaggedExists refuses an overflowing count', async () => {
        // Number('9'.repeat(400)) is Infinity: resolveRange('*') would then compile the literal
        // string "Infinity" and every range-based command would fail until the next SELECT
        let client = makeClient();
        client.mailbox = { path: 'INBOX', exists: 5 };
        let events = [];
        client.on('exists', (e: any) => events.push(e));

        await client.untaggedExists(false as any);
        await client.untaggedExists({});
        for (let bad of ['9'.repeat(400), '1e5', '-1', 'abc', '1.5', '']) {
            await client.untaggedExists({ command: bad });
        }
        assert.equal(client.mailbox.exists, 5, 'the live message count must be left alone');
        assert.equal(events.length, 0);

        await client.untaggedExists({ command: '7' });
        assert.equal(client.mailbox.exists, 7, 'a usable count is still applied');
        assert.equal(events.length, 1);
    });
    it('Methods: throttleWait caps the delay and close() aborts it', async () => {
        let client = makeClient();

        // A server hint is unbounded; the wait may never outlive the client either
        let started = Date.now();
        let pending = client.throttleWait(7 * 24 * 3600 * 1000);
        assert.equal(client._throttleWaits.size, 1, 'the wait is tracked so close() can reach it');

        client.close();
        assert.equal(await pending, true, 'an aborted wait reports true');
        assert.equal(client._throttleWaits.size, 0, 'the tracked wait is released');
        assert.ok(Date.now() - started < 5000, 'close() must not wait out the delay');

        // normal expiry reports false and releases the entry. The back-off timer is deliberately
        // unref'd, so the test has to hold the event loop open itself - in a real session the
        // socket does that.
        let client2 = makeClient();
        let keepAlive = setTimeout(() => {}, 1000);
        assert.equal(await client2.throttleWait(1), false);
        clearTimeout(keepAlive);
        assert.equal(client2._throttleWaits.size, 0);
        client2.close();
    });
});
