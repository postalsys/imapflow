'use strict';

// Unit tests that exercise ImapFlow public/command methods against a real
// ImapFlow instance with `run` (and occasionally lower-level helpers) stubbed.
// This deterministically covers the thin command wrappers, range resolution,
// the untagged response handlers, and the fetch/download orchestration without
// requiring a live IMAP server.

const { ImapFlow } = require('../lib/imap-flow');

// Build a real ImapFlow instance with logging disabled and a selected mailbox.
// `run` is stubbed by default to record calls and return a configurable value.
const makeClient = (overrides = {}) => {
    let client = new ImapFlow({
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
const recordRun = (client, returnValue) => {
    let calls = [];
    client.run = async (...args) => {
        calls.push(args);
        return typeof returnValue === 'function' ? returnValue(...args) : returnValue;
    };
    return calls;
};

// ============================================================================
// Thin command wrappers
// ============================================================================

module.exports['Methods: getQuota defaults path to INBOX'] = async test => {
    let client = makeClient();
    let calls = recordRun(client, { path: 'INBOX' });
    let res = await client.getQuota();
    test.deepEqual(calls[0], ['QUOTA', 'INBOX']);
    test.deepEqual(res, { path: 'INBOX' });
    test.done();
};

module.exports['Methods: getQuota uses given path'] = async test => {
    let client = makeClient();
    let calls = recordRun(client, false);
    await client.getQuota('Archive');
    test.deepEqual(calls[0], ['QUOTA', 'Archive']);
    test.done();
};

module.exports['Methods: list builds folders map'] = async test => {
    let client = makeClient();
    recordRun(client, [
        { path: 'INBOX', name: 'INBOX' },
        { path: 'Sent', name: 'Sent' }
    ]);
    let folders = await client.list();
    test.equal(folders.length, 2);
    test.ok(client.folders instanceof Map);
    test.equal(client.folders.get('Sent').name, 'Sent');
    test.done();
};

module.exports['Methods: list passes options'] = async test => {
    let client = makeClient();
    let calls = recordRun(client, []);
    await client.list({ statusQuery: { messages: true } });
    test.deepEqual(calls[0][0], 'LIST');
    test.deepEqual(calls[0][3], { statusQuery: { messages: true } });
    test.done();
};

module.exports['Methods: listTree returns tree structure'] = async test => {
    let client = makeClient();
    recordRun(client, [
        { path: 'INBOX', name: 'INBOX', delimiter: '/', parent: [], flags: new Set() },
        { path: 'INBOX/Sub', name: 'Sub', delimiter: '/', parent: ['INBOX'], flags: new Set() }
    ]);
    let tree = await client.listTree();
    test.ok(tree);
    test.ok(Array.isArray(tree.folders));
    test.ok(client.folders instanceof Map);
    test.done();
};

module.exports['Methods: noop dispatches NOOP'] = async test => {
    let client = makeClient();
    let calls = recordRun(client, true);
    await client.noop();
    test.deepEqual(calls[0], ['NOOP']);
    test.done();
};

module.exports['Methods: mailboxCreate dispatches CREATE'] = async test => {
    let client = makeClient();
    let calls = recordRun(client, { path: 'New', created: true });
    let res = await client.mailboxCreate(['parent', 'child']);
    test.deepEqual(calls[0], ['CREATE', ['parent', 'child']]);
    test.equal(res.created, true);
    test.done();
};

module.exports['Methods: mailboxRename dispatches RENAME'] = async test => {
    let client = makeClient();
    let calls = recordRun(client, { path: 'a', newPath: 'b' });
    await client.mailboxRename('a', 'b');
    test.deepEqual(calls[0], ['RENAME', 'a', 'b']);
    test.done();
};

module.exports['Methods: mailboxDelete dispatches DELETE'] = async test => {
    let client = makeClient();
    let calls = recordRun(client, { path: 'a' });
    await client.mailboxDelete('a');
    test.deepEqual(calls[0], ['DELETE', 'a']);
    test.done();
};

module.exports['Methods: mailboxSubscribe dispatches SUBSCRIBE'] = async test => {
    let client = makeClient();
    let calls = recordRun(client, true);
    await client.mailboxSubscribe('a');
    test.deepEqual(calls[0], ['SUBSCRIBE', 'a']);
    test.done();
};

module.exports['Methods: mailboxUnsubscribe dispatches UNSUBSCRIBE'] = async test => {
    let client = makeClient();
    let calls = recordRun(client, true);
    await client.mailboxUnsubscribe('a');
    test.deepEqual(calls[0], ['UNSUBSCRIBE', 'a']);
    test.done();
};

module.exports['Methods: mailboxOpen dispatches SELECT'] = async test => {
    let client = makeClient();
    let calls = recordRun(client, { path: 'INBOX' });
    await client.mailboxOpen('INBOX', { readOnly: true });
    test.deepEqual(calls[0], ['SELECT', 'INBOX', { readOnly: true }]);
    test.done();
};

module.exports['Methods: mailboxClose dispatches CLOSE'] = async test => {
    let client = makeClient();
    let calls = recordRun(client, true);
    await client.mailboxClose();
    test.deepEqual(calls[0], ['CLOSE']);
    test.done();
};

module.exports['Methods: status dispatches STATUS'] = async test => {
    let client = makeClient();
    let calls = recordRun(client, { path: 'INBOX', unseen: 3 });
    let res = await client.status('INBOX', { unseen: true });
    test.deepEqual(calls[0], ['STATUS', 'INBOX', { unseen: true }]);
    test.equal(res.unseen, 3);
    test.done();
};

// ============================================================================
// idle()
// ============================================================================

module.exports['Methods: idle runs IDLE when not already idling'] = async test => {
    let client = makeClient();
    let calls = recordRun(client, true);
    await client.idle();
    test.deepEqual(calls[0], ['IDLE', client.maxIdleTime]);
    test.done();
};

module.exports['Methods: idle is a no-op when already idling'] = async test => {
    let client = makeClient();
    client.idling = true;
    let calls = recordRun(client, true);
    let res = await client.idle();
    test.equal(calls.length, 0);
    test.equal(res, undefined);
    test.done();
};

// ============================================================================
// Flag operations + range resolution
// ============================================================================

module.exports['Methods: messageFlagsSet resolves range and dispatches STORE'] = async test => {
    let client = makeClient();
    let calls = recordRun(client, true);
    let res = await client.messageFlagsSet('1:5', ['\\Seen'], { uid: true });
    test.equal(res, true);
    test.equal(calls[0][0], 'STORE');
    test.equal(calls[0][1], '1:5');
    test.deepEqual(calls[0][3], { operation: 'set', uid: true });
    test.done();
};

module.exports['Methods: messageFlagsSet works without an options argument'] = async test => {
    let client = makeClient();
    let calls = recordRun(client, true);
    let res = await client.messageFlagsSet('1', ['\\Seen']); // no options -> options || {}
    test.equal(res, true);
    test.equal(calls[0][0], 'STORE');
    test.done();
};

module.exports['Methods: search derivation handles non-string returnOptions entries'] = async test => {
    let client = makeClient();
    recordRun(client, [1, 2, 3]); // no ESEARCH -> client-side derivation runs
    // a non-string returnOption (object) is passed through untouched by the mapper
    let res = await client.search({ all: true }, { returnOptions: ['count', { partial: '1:2' }] });
    test.equal(res.count, 3);
    test.done();
};

module.exports['Methods: messageFlagsSet returns false for empty range'] = async test => {
    let client = makeClient();
    let calls = recordRun(client, true);
    let res = await client.messageFlagsSet([], ['\\Seen'], {});
    test.equal(res, false);
    test.equal(calls.length, 0);
    test.done();
};

module.exports['Methods: messageFlagsAdd dispatches STORE add'] = async test => {
    let client = makeClient();
    let calls = recordRun(client, true);
    await client.messageFlagsAdd('1', ['\\Flagged']);
    test.equal(calls[0][3].operation, 'add');
    test.done();
};

module.exports['Methods: messageFlagsAdd returns false on empty range'] = async test => {
    let client = makeClient();
    recordRun(client, true);
    let res = await client.messageFlagsAdd([], ['\\Flagged']);
    test.equal(res, false);
    test.done();
};

module.exports['Methods: messageFlagsRemove dispatches STORE remove'] = async test => {
    let client = makeClient();
    let calls = recordRun(client, true);
    await client.messageFlagsRemove('1', ['\\Flagged']);
    test.equal(calls[0][3].operation, 'remove');
    test.done();
};

module.exports['Methods: messageFlagsRemove returns false on empty range'] = async test => {
    let client = makeClient();
    recordRun(client, true);
    let res = await client.messageFlagsRemove([], ['\\Flagged']);
    test.equal(res, false);
    test.done();
};

module.exports['Methods: setFlagColor returns false for empty range'] = async test => {
    let client = makeClient();
    recordRun(client, true);
    let res = await client.setFlagColor([], 'red');
    test.equal(res, false);
    test.done();
};

module.exports['Methods: setFlagColor returns false for invalid color'] = async test => {
    let client = makeClient();
    recordRun(client, true);
    let res = await client.setFlagColor('1', 'not-a-color');
    test.equal(res, false);
    test.done();
};

module.exports['Methods: setFlagColor red issues add and remove STORE'] = async test => {
    let client = makeClient();
    let calls = recordRun(client, true);
    // red sets \\Flagged and clears the MailFlagBit* keywords -> both add and remove
    let res = await client.setFlagColor('1:*', 'red');
    test.ok(res);
    let ops = calls.map(c => c[3].operation);
    test.ok(ops.includes('add'));
    test.ok(ops.includes('remove'));
    test.done();
};

module.exports['Methods: setFlagColor removal (null color) issues only a remove STORE'] = async test => {
    test.expect(5);
    let client = makeClient();
    let calls = recordRun(client, true);
    // A null/empty color clears the color: getColorFlags returns an empty add set and a
    // non-empty remove set, so the add STORE is skipped and only the remove STORE runs.
    let res = await client.setFlagColor('1', null);
    test.ok(res);
    test.equal(calls.length, 1);
    test.equal(calls[0][0], 'STORE');
    test.equal(calls[0][3].operation, 'remove');
    test.deepEqual(calls[0][2], ['\\Flagged', '$MailFlagBit0', '$MailFlagBit1', '$MailFlagBit2']);
    test.done();
};

module.exports['Methods: messageDelete resolves range and dispatches EXPUNGE'] = async test => {
    let client = makeClient();
    let calls = recordRun(client, true);
    let res = await client.messageDelete('1:3', { uid: true });
    test.equal(res, true);
    test.equal(calls[0][0], 'EXPUNGE');
    test.equal(calls[0][1], '1:3');
    test.done();
};

module.exports['Methods: messageDelete returns false on empty range'] = async test => {
    let client = makeClient();
    recordRun(client, true);
    let res = await client.messageDelete([]);
    test.equal(res, false);
    test.done();
};

// ============================================================================
// append / copy / move
// ============================================================================

module.exports['Methods: append dispatches APPEND'] = async test => {
    let client = makeClient();
    let calls = recordRun(client, { destination: 'INBOX', uid: 5 });
    let res = await client.append('INBOX', 'raw message', ['\\Seen'], new Date(2020, 1, 1));
    test.equal(calls[0][0], 'APPEND');
    test.equal(res.uid, 5);
    test.done();
};

module.exports['Methods: append returns false when run returns falsy'] = async test => {
    let client = makeClient();
    recordRun(client, false);
    let res = await client.append('INBOX', 'raw');
    test.equal(res, false);
    test.done();
};

module.exports['Methods: messageCopy resolves range and dispatches COPY'] = async test => {
    let client = makeClient();
    let calls = recordRun(client, { destination: 'Backup' });
    await client.messageCopy('1:*', 'Backup', { uid: false });
    test.equal(calls[0][0], 'COPY');
    test.equal(calls[0][2], 'Backup');
    test.done();
};

module.exports['Methods: messageCopy returns false on empty range'] = async test => {
    let client = makeClient();
    recordRun(client, true);
    let res = await client.messageCopy([], 'Backup');
    test.equal(res, false);
    test.done();
};

module.exports['Methods: messageMove resolves range and dispatches MOVE'] = async test => {
    let client = makeClient();
    let calls = recordRun(client, { destination: 'Trash' });
    await client.messageMove('1', 'Trash');
    test.equal(calls[0][0], 'MOVE');
    test.equal(calls[0][2], 'Trash');
    test.done();
};

module.exports['Methods: messageMove returns false on empty range'] = async test => {
    let client = makeClient();
    recordRun(client, true);
    let res = await client.messageMove([], 'Trash');
    test.equal(res, false);
    test.done();
};

// ============================================================================
// resolveRange branches
// ============================================================================

module.exports['Methods: resolveRange converts number'] = async test => {
    let client = makeClient();
    let res = await client.resolveRange(5, {});
    test.equal(res, '5');
    test.done();
};

module.exports['Methods: resolveRange converts bigint'] = async test => {
    let client = makeClient();
    let res = await client.resolveRange(BigInt(7), {});
    test.equal(res, '7');
    test.done();
};

module.exports['Methods: resolveRange star uses mailbox.exists'] = async test => {
    let client = makeClient();
    let options = {};
    let res = await client.resolveRange('*', options);
    test.equal(res, '10');
    test.equal(options.uid, false);
    test.done();
};

module.exports['Methods: resolveRange star returns false on empty mailbox'] = async test => {
    let client = makeClient();
    client.mailbox.exists = 0;
    let res = await client.resolveRange('*', {});
    test.equal(res, false);
    test.done();
};

module.exports['Methods: resolveRange all:true => 1:*'] = async test => {
    let client = makeClient();
    let res = await client.resolveRange({ all: true }, {});
    test.equal(res, '1:*');
    test.done();
};

module.exports['Methods: resolveRange uid object'] = async test => {
    let client = makeClient();
    let options = {};
    let res = await client.resolveRange({ uid: '100:200' }, options);
    test.equal(res, '100:200');
    test.equal(options.uid, true);
    test.done();
};

module.exports['Methods: resolveRange search query runs SEARCH and packs'] = async test => {
    let client = makeClient();
    let options = {};
    client.run = async (cmd, query, opts) => {
        test.equal(cmd, 'SEARCH');
        test.equal(opts.uid, true);
        return [1, 2, 3, 5];
    };
    let res = await client.resolveRange({ seen: false }, options);
    test.equal(res, '1:3,5');
    test.done();
};

module.exports['Methods: resolveRange search query with no hits'] = async test => {
    let client = makeClient();
    client.run = async () => [];
    let res = await client.resolveRange({ seen: false }, {});
    test.equal(res, false);
    test.done();
};

module.exports['Methods: resolveRange array joins with commas'] = async test => {
    let client = makeClient();
    let res = await client.resolveRange([1, 2, 4], {});
    test.equal(res, '1,2,4');
    test.done();
};

module.exports['Methods: resolveRange empty string returns false'] = async test => {
    let client = makeClient();
    let res = await client.resolveRange('', {});
    test.equal(res, false);
    test.done();
};

// ============================================================================
// ensureSelectedMailbox
// ============================================================================

module.exports['Methods: ensureSelectedMailbox returns false without path'] = async test => {
    let client = makeClient();
    let res = await client.ensureSelectedMailbox(null);
    test.equal(res, false);
    test.done();
};

module.exports['Methods: ensureSelectedMailbox returns true when already selected'] = async test => {
    let client = makeClient();
    let res = await client.ensureSelectedMailbox('INBOX');
    test.equal(res, true);
    test.done();
};

module.exports['Methods: ensureSelectedMailbox opens a different mailbox'] = async test => {
    let client = makeClient();
    let calls = recordRun(client, { path: 'Other' });
    await client.ensureSelectedMailbox('Other');
    test.equal(calls[0][0], 'SELECT');
    test.equal(calls[0][1], 'Other');
    test.done();
};

// ============================================================================
// search()
// ============================================================================

module.exports['Methods: search returns undefined without mailbox'] = async test => {
    let client = makeClient();
    client.mailbox = false;
    let res = await client.search({ seen: false });
    test.equal(res, undefined);
    test.done();
};

module.exports['Methods: search returns server result'] = async test => {
    let client = makeClient();
    recordRun(client, [1, 2, 3]);
    let res = await client.search({ seen: false });
    test.deepEqual(res, [1, 2, 3]);
    test.done();
};

module.exports['Methods: search returns false when run returns falsy'] = async test => {
    let client = makeClient();
    recordRun(client, null);
    let res = await client.search({ all: true });
    test.equal(res, false);
    test.done();
};

module.exports['Methods: search derives ESearch COUNT/MIN/MAX/ALL client-side'] = async test => {
    let client = makeClient();
    recordRun(client, [2, 4, 6, 8]);
    let res = await client.search({ all: true }, { returnOptions: ['count', 'min', 'max', 'all'] });
    test.equal(res.count, 4);
    test.equal(res.min, 2);
    test.equal(res.max, 8);
    test.equal(res.all, '2,4,6,8');
    test.done();
};

module.exports['Methods: search returnOptions PARTIAL only returns raw array'] = async test => {
    let client = makeClient();
    recordRun(client, [1, 2, 3]);
    let res = await client.search({ all: true }, { returnOptions: ['partial'] });
    test.deepEqual(res, [1, 2, 3]);
    test.done();
};

// ============================================================================
// Untagged response handlers
// ============================================================================

module.exports['Methods: untaggedExists ignores when no mailbox'] = async test => {
    let client = makeClient();
    client.mailbox = false;
    await client.untaggedExists({ command: '12' });
    test.ok(true);
    test.done();
};

module.exports['Methods: untaggedExists ignores invalid command'] = async test => {
    let client = makeClient();
    let fired = false;
    client.on('exists', () => {
        fired = true;
    });
    await client.untaggedExists({ command: 'NaNvalue' });
    test.equal(fired, false);
    test.done();
};

module.exports['Methods: untaggedExists no-op when count unchanged'] = async test => {
    let client = makeClient();
    client.mailbox.exists = 10;
    let fired = false;
    client.on('exists', () => {
        fired = true;
    });
    await client.untaggedExists({ command: '10' });
    test.equal(fired, false);
    test.done();
};

module.exports['Methods: untaggedExists emits exists event on change'] = async test => {
    let client = makeClient();
    client.mailbox.exists = 10;
    let evt = null;
    client.on('exists', e => {
        evt = e;
    });
    await client.untaggedExists({ command: '12' });
    test.ok(evt);
    test.equal(evt.count, 12);
    test.equal(evt.prevCount, 10);
    test.equal(client.mailbox.exists, 12);
    test.done();
};

module.exports['Methods: untaggedExpunge ignores when no mailbox'] = async test => {
    let client = makeClient();
    client.mailbox = false;
    await client.untaggedExpunge({ command: '2' });
    test.ok(true);
    test.done();
};

module.exports['Methods: untaggedExpunge ignores invalid command'] = async test => {
    let client = makeClient();
    let fired = false;
    client.on('expunge', () => {
        fired = true;
    });
    await client.untaggedExpunge({ command: 'x' });
    test.equal(fired, false);
    test.done();
};

module.exports['Methods: untaggedExpunge emits expunge event'] = async test => {
    let client = makeClient();
    client.mailbox.exists = 10;
    let evt = null;
    client.on('expunge', e => {
        evt = e;
    });
    await client.untaggedExpunge({ command: '3' });
    test.ok(evt);
    test.equal(evt.seq, 3);
    test.equal(evt.vanished, false);
    test.equal(client.mailbox.exists, 9);
    test.done();
};

module.exports['Methods: untaggedExpunge uses expungeHandler when set'] = async test => {
    let payloads = [];
    let client = makeClient({ expungeHandler: async payload => payloads.push(payload) });
    client.mailbox.exists = 5;
    await client.untaggedExpunge({ command: '2' });
    test.equal(payloads.length, 1);
    test.equal(payloads[0].seq, 2);
    test.done();
};

module.exports['Methods: untaggedExpunge handles expungeHandler error'] = async test => {
    let client = makeClient({
        expungeHandler: async () => {
            throw new Error('handler boom');
        }
    });
    client.mailbox.exists = 5;
    // Should not throw despite handler error
    await client.untaggedExpunge({ command: '2' });
    test.ok(true);
    test.done();
};

module.exports['Methods: untaggedVanished ignores when no mailbox'] = async test => {
    let client = makeClient();
    client.mailbox = false;
    await client.untaggedVanished({ attributes: [{ value: '1:3' }] });
    test.ok(true);
    test.done();
};

module.exports['Methods: untaggedVanished emits expunge per uid'] = async test => {
    let client = makeClient();
    let events = [];
    client.on('expunge', e => events.push(e));
    await client.untaggedVanished({ attributes: [{ value: '1:3' }] });
    test.equal(events.length, 3);
    test.equal(events[0].uid, 1);
    test.equal(events[0].vanished, true);
    test.equal(events[0].earlier, false);
    test.done();
};

module.exports['Methods: untaggedVanished EARLIER tag sets earlier flag'] = async test => {
    let client = makeClient();
    let events = [];
    client.on('expunge', e => events.push(e));
    await client.untaggedVanished({
        attributes: [[{ value: 'EARLIER' }], { value: '5' }]
    });
    test.equal(events.length, 1);
    test.equal(events[0].uid, 5);
    test.equal(events[0].earlier, true);
    test.done();
};

module.exports['Methods: untaggedVanished routes through expungeHandler'] = async test => {
    let payloads = [];
    let client = makeClient({ expungeHandler: async p => payloads.push(p) });
    await client.untaggedVanished({ attributes: [{ value: '7' }] });
    test.equal(payloads.length, 1);
    test.equal(payloads[0].uid, 7);
    test.done();
};

module.exports['Methods: untaggedVanished swallows expungeHandler error'] = async test => {
    let client = makeClient({
        expungeHandler: async () => {
            throw new Error('vanished boom');
        }
    });
    await client.untaggedVanished({ attributes: [{ value: '7' }] });
    test.ok(true);
    test.done();
};

module.exports['Methods: untaggedFetch ignores when no mailbox'] = async test => {
    let client = makeClient();
    client.mailbox = false;
    await client.untaggedFetch({ command: '1', attributes: [] });
    test.ok(true);
    test.done();
};

module.exports['Methods: untaggedFetch emits flags event'] = async test => {
    let client = makeClient();
    let evt = null;
    client.on('flags', e => {
        evt = e;
    });
    // Build an untagged FETCH with FLAGS and UID attributes
    let untagged = {
        command: '1',
        attributes: [
            { type: 'ATOM', value: 'FETCH' },
            [
                { type: 'ATOM', value: 'UID' },
                { type: 'ATOM', value: '100' },
                { type: 'ATOM', value: 'FLAGS' },
                [{ type: 'ATOM', value: '\\Seen' }]
            ]
        ]
    };
    await client.untaggedFetch(untagged);
    test.ok(evt);
    test.equal(evt.uid, 100);
    test.ok(evt.flags instanceof Set);
    test.ok(evt.flags.has('\\Seen'));
    test.done();
};
