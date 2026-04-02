'use strict';

const searchCmd = require('../lib/commands/search');
const { parseEsearchResponse } = searchCmd;
const { ImapFlow } = require('../lib/imap-flow');

// Mock connection — capabilities is Map (matches real ImapFlow)
function makeConnection({ hasEsearch = true } = {}) {
    const caps = new Map();
    if (hasEsearch) {
        caps.set('ESEARCH', true);
    }
    return {
        state: 'SELECTED',
        states: { SELECTED: 'SELECTED' },
        capabilities: caps,
        exec: async () => ({ next: () => {} }),
        log: { warn: () => {} }
    };
}

// ── Parser tests ───────────────────────────────────────────────────────────

module.exports['ESEARCH: parseEsearchResponse COUNT only'] = test => {
    const attrs = [
        { type: 'ATOM', value: 'COUNT' },
        { type: 'ATOM', value: '42' }
    ];
    const result = parseEsearchResponse(attrs);
    test.equal(result.count, 42);
    test.equal(result.min, undefined);
    test.equal(result.max, undefined);
    test.done();
};

module.exports['ESEARCH: parseEsearchResponse MIN MAX'] = test => {
    const attrs = [
        { type: 'ATOM', value: 'MIN' },
        { type: 'ATOM', value: '1001' },
        { type: 'ATOM', value: 'MAX' },
        { type: 'ATOM', value: '9876' }
    ];
    const result = parseEsearchResponse(attrs);
    test.equal(result.min, 1001);
    test.equal(result.max, 9876);
    test.done();
};

module.exports['ESEARCH: parseEsearchResponse ALL keeps compact string'] = test => {
    const attrs = [
        { type: 'ATOM', value: 'ALL' },
        { type: 'ATOM', value: '1001,1005:1010,1020' }
    ];
    const result = parseEsearchResponse(attrs);
    // Must be preserved as compact string — NOT an array
    test.equal(typeof result.all, 'string');
    test.equal(result.all, '1001,1005:1010,1020');
    test.done();
};

module.exports['ESEARCH: parseEsearchResponse PARTIAL (Array form)'] = test => {
    // Parser represents parenthesized groups as plain Arrays
    const attrs = [
        { type: 'ATOM', value: 'PARTIAL' },
        [
            { type: 'ATOM', value: '1:100' },
            { type: 'ATOM', value: '1001,1003:1010,1015' }
        ]
    ];
    const result = parseEsearchResponse(attrs);
    test.deepEqual(result.partial, { range: '1:100', messages: '1001,1003:1010,1015' });
    test.done();
};

module.exports['ESEARCH: parseEsearchResponse PARTIAL (LIST object form)'] = test => {
    // Also handle {type: 'LIST', attributes: [...]} form for robustness
    const attrs = [
        { type: 'ATOM', value: 'PARTIAL' },
        {
            type: 'LIST',
            attributes: [
                { type: 'ATOM', value: '1:100' },
                { type: 'ATOM', value: '1001,1003:1010,1015' }
            ]
        }
    ];
    const result = parseEsearchResponse(attrs);
    test.deepEqual(result.partial, { range: '1:100', messages: '1001,1003:1010,1015' });
    test.done();
};

module.exports['ESEARCH: parseEsearchResponse COUNT + PARTIAL combined'] = test => {
    const attrs = [
        { type: 'ATOM', value: 'COUNT' },
        { type: 'ATOM', value: '34201' },
        { type: 'ATOM', value: 'PARTIAL' },
        [
            { type: 'ATOM', value: '1:100' },
            { type: 'ATOM', value: '2001,2003:2020' }
        ]
    ];
    const result = parseEsearchResponse(attrs);
    test.equal(result.count, 34201);
    test.deepEqual(result.partial, { range: '1:100', messages: '2001,2003:2020' });
    test.done();
};

// ── Command-building tests ─────────────────────────────────────────────────

module.exports['ESEARCH: emits RETURN clause when returnOptions present and server has ESEARCH'] = test => {
    const conn = makeConnection({ hasEsearch: true });
    let capturedCommand = null;
    let capturedAttributes = null;
    conn.exec = async (command, attributes) => {
        capturedCommand = command;
        capturedAttributes = JSON.stringify(attributes);
        return { next: () => {} };
    };
    searchCmd(conn, { seen: false }, { uid: true, returnOptions: ['COUNT'] }).then(() => {
        test.equal(capturedCommand, 'UID SEARCH');
        test.ok(capturedAttributes.includes('"RETURN"'), 'should include RETURN atom');
        test.ok(capturedAttributes.includes('"COUNT"'), 'should include COUNT in return list');
        test.done();
    }).catch(err => test.done(err));
};

module.exports['ESEARCH: RETURN clause includes PARTIAL range atom'] = test => {
    const conn = makeConnection({ hasEsearch: true });
    let capturedAttributes = null;
    conn.exec = async (command, attributes) => {
        capturedAttributes = JSON.stringify(attributes);
        return { next: () => {} };
    };
    searchCmd(conn, { seen: false }, { uid: true, returnOptions: [{ partial: '1:100' }] }).then(() => {
        test.ok(capturedAttributes.includes('"PARTIAL"'), 'should include PARTIAL atom');
        test.ok(capturedAttributes.includes('"1:100"'), 'should include range string');
        test.done();
    }).catch(err => test.done(err));
};

module.exports['ESEARCH: no RETURN clause when server lacks ESEARCH capability'] = test => {
    const conn = makeConnection({ hasEsearch: false });
    let capturedAttributes = null;
    conn.exec = async (command, attributes, handlers) => {
        capturedAttributes = JSON.stringify(attributes);
        // Simulate plain SEARCH response
        const searchHandler = handlers && handlers.untagged && handlers.untagged.SEARCH;
        if (searchHandler) {
            await searchHandler({
                attributes: [{ value: '1' }, { value: '2' }, { value: '3' }]
            });
        }
        return { next: () => {} };
    };
    searchCmd(conn, { seen: false }, { uid: true, returnOptions: ['COUNT', 'ALL'] }).then(result => {
        test.ok(!capturedAttributes.includes('"RETURN"'), 'should NOT include RETURN when no ESEARCH');
        test.ok(Array.isArray(result), 'should return number[] when ESEARCH unavailable');
        test.deepEqual(result, [1, 2, 3]);
        test.done();
    }).catch(err => test.done(err));
};

module.exports['ESEARCH: parseEsearchResponse ignores unknown keywords'] = test => {
    // Dovecot with CONDSTORE may append MODSEQ to ESEARCH responses
    const attrs = [
        { type: 'ATOM', value: 'COUNT' },
        { type: 'ATOM', value: '5' },
        { type: 'ATOM', value: 'MODSEQ' },
        { type: 'ATOM', value: '12345' }
    ];
    const result = parseEsearchResponse(attrs);
    test.equal(result.count, 5);
    test.equal(result.modseq, undefined, 'unknown keys should not appear in result');
    test.done();
};

module.exports['ESEARCH: backward compat — no returnOptions returns number[]'] = test => {
    const conn = makeConnection({ hasEsearch: true });
    conn.exec = async (command, attributes, handlers) => {
        const searchHandler = handlers && handlers.untagged && handlers.untagged.SEARCH;
        if (searchHandler) {
            await searchHandler({
                attributes: [{ value: '10' }, { value: '20' }]
            });
        }
        return { next: () => {} };
    };
    // No returnOptions — must return number[] even if server has ESEARCH
    searchCmd(conn, { seen: true }, { uid: true }).then(result => {
        test.ok(Array.isArray(result));
        test.deepEqual(result, [10, 20]);
        test.done();
    }).catch(err => test.done(err));
};

// ── imap-flow.js public API fallback test ─────────────────────────────────
module.exports['imap-flow: search() derives ESearchResult when server has no ESEARCH'] = test => {
    const client = new ImapFlow({
        host: 'imap.example.com',
        port: 993,
        auth: { user: 'test', pass: 'test' },
        logger: false
    });

    // Simulate a selected mailbox and no ESEARCH capability
    client.mailbox = { path: 'INBOX' };
    client.state = client.states.SELECTED;
    client.capabilities = new Map(); // no ESEARCH

    // Stub run() to return a sorted number[]
    client.run = async () => [10, 20, 30, 40, 50];

    client.search({ seen: false }, { uid: true, returnOptions: ['COUNT', 'MIN', 'MAX', 'ALL'] }).then(result => {
        test.equal(typeof result, 'object', 'should return object, not array');
        test.ok(!Array.isArray(result), 'should not be an array');
        test.equal(result.count, 5);
        test.equal(result.min, 10);
        test.equal(result.max, 50);
        // packMessageRange([10,20,30,40,50]) → "10,20,30,40,50" (non-contiguous)
        test.ok(typeof result.all === 'string' && result.all.length > 0, 'all should be non-empty compact string');
        test.done();
    }).catch(err => test.done(err));
};

module.exports['imap-flow: search() fallback with empty result set'] = test => {
    const client = new ImapFlow({
        host: 'imap.example.com',
        port: 993,
        auth: { user: 'test', pass: 'test' },
        logger: false
    });
    client.mailbox = { path: 'INBOX' };
    client.state = client.states.SELECTED;
    client.capabilities = new Map();
    client.run = async () => [];
    client.search({}, { uid: true, returnOptions: ['COUNT', 'ALL'] }).then(result => {
        test.equal(result.count, 0);
        test.equal(result.all, undefined, 'all should be absent for empty result');
        test.done();
    }).catch(err => test.done(err));
};
