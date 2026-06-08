'use strict';

/* eslint-disable new-cap */
// BigInt() is a standard JS function but triggers new-cap rule

// ============================================================================
// Additional branch-coverage tests for lib/commands/*.js
//
// Each test targets one or more specific uncovered branches identified via c8.
// The mock connection factory mirrors the one in commands-integration-test.js.
// ============================================================================

const createMockConnection = (overrides = {}) => {
    const states = {
        NOT_AUTHENTICATED: 1,
        AUTHENTICATED: 2,
        SELECTED: 3,
        LOGOUT: 4
    };

    const defaultMailbox = {
        path: 'INBOX',
        flags: new Set(['\\Seen', '\\Answered', '\\Flagged', '\\Deleted', '\\Draft']),
        permanentFlags: new Set(['\\*']),
        exists: 100,
        recent: 5,
        uidNext: 1000,
        uidValidity: BigInt(12345),
        noModseq: false
    };

    return {
        states,
        state: overrides.state || states.SELECTED,
        id: 'test-connection-id',
        capabilities: new Map(overrides.capabilities || [['IMAP4rev1', true]]),
        enabled: new Set(overrides.enabled || []),
        authCapabilities: new Map(),
        folders: overrides.folders || new Map(),
        mailbox: overrides.mailbox || { ...defaultMailbox },
        namespace: overrides.namespace || { delimiter: '/', prefix: '' },
        expectCapabilityUpdate: overrides.expectCapabilityUpdate || false,
        log: {
            warn: () => {},
            info: () => {},
            error: () => {},
            debug: () => {},
            trace: () => {}
        },
        close: overrides.close || (() => {}),
        emit: overrides.emit || (() => {}),
        write: overrides.write || (() => {}),
        currentSelectCommand: false,
        messageFlagsAdd: overrides.messageFlagsAdd || (async () => {}),
        messageCopy: overrides.messageCopy || (async () => {}),
        messageDelete: overrides.messageDelete || (async () => {}),
        run: overrides.run || (async () => {}),
        exec:
            overrides.exec ||
            (async () => ({
                next: () => {},
                response: { attributes: [] }
            })),
        ...overrides
    };
};

// ============================================================================
// copy.js — line 22 branch: `options = options || {}` with falsy options
// Call copy with range + destination but no options argument so the `|| {}`
// right-hand side is taken.
// ============================================================================

const copyCommand = require('../lib/commands/copy');

module.exports['Branches: copy with undefined options uses {} fallback'] = async test => {
    let execCmd = null;
    const connection = createMockConnection({
        state: 3,
        exec: async cmd => {
            execCmd = cmd;
            return { next: () => {}, response: { attributes: [] } };
        }
    });

    // No options argument -> options is undefined -> `options || {}` fallback
    const result = await copyCommand(connection, '1:5', 'Archive');
    test.ok(result);
    test.equal(execCmd, 'COPY'); // not UID COPY, since options.uid is undefined
    test.done();
};

// ============================================================================
// move.js — line 22 branch: `options = options || {}` with falsy options
// MOVE capability present, no options argument.
// ============================================================================

const moveCommand = require('../lib/commands/move');

module.exports['Branches: move with undefined options uses {} fallback'] = async test => {
    let execCmd = null;
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['MOVE', true]]),
        exec: async cmd => {
            execCmd = cmd;
            return { next: () => {}, response: { attributes: [] } };
        }
    });

    const result = await moveCommand(connection, '1:5', 'Archive');
    test.ok(result);
    test.equal(execCmd, 'MOVE');
    test.done();
};

// ============================================================================
// expunge.js — line 20 branch: `options = options || {}` with falsy options
// Call expunge with range but no options argument.
// ============================================================================

const expungeCommand = require('../lib/commands/expunge');

module.exports['Branches: expunge with undefined options uses {} fallback'] = async test => {
    let execCmd = null;
    const connection = createMockConnection({
        state: 3,
        exec: async cmd => {
            execCmd = cmd;
            return { next: () => {}, response: { attributes: [] } };
        }
    });

    // No options argument -> options || {} fallback; byUid false -> plain EXPUNGE
    const result = await expungeCommand(connection, '1:5');
    test.equal(result, true);
    test.equal(execCmd, 'EXPUNGE');
    test.done();
};

// ============================================================================
// store.js — line 56 branch: `: [].concat(flags || [])` — flags passed as a
// single (non-array) value, so the Array.isArray() ternary takes the false side.
// ============================================================================

const storeCommand = require('../lib/commands/store');

module.exports['Branches: store with a single non-array flag value'] = async test => {
    let storedFlags = null;
    const connection = createMockConnection({
        state: 3,
        mailbox: { path: 'INBOX', flags: new Set(['\\Seen']), permanentFlags: new Set(['\\Seen']) },
        exec: async (cmd, attrs) => {
            // attrs[2] is the flags list
            storedFlags = attrs[2].map(a => a.value);
            return { next: () => {}, response: { attributes: [] } };
        }
    });

    // flags is a single string, not an array -> exercises `[].concat(flags || [])`
    const result = await storeCommand(connection, '1:5', '\\Seen', { operation: 'add' });
    test.equal(result, true);
    test.deepEqual(storedFlags, ['\\Seen']);
    test.done();
};

module.exports['Branches: store with falsy flags and set operation uses [] fallback'] = async test => {
    let storedFlags = null;
    const connection = createMockConnection({
        state: 3,
        mailbox: { path: 'INBOX', flags: new Set(['\\Seen']), permanentFlags: new Set(['\\Seen']) },
        exec: async (cmd, attrs) => {
            storedFlags = attrs[2].map(a => a.value);
            return { next: () => {}, response: { attributes: [] } };
        }
    });

    // flags is undefined (falsy, non-array) -> exercises the `flags || []` fallback in
    // `[].concat(flags || [])`. Empty flags are allowed for the 'set' operation (clears all).
    const result = await storeCommand(connection, '1:5', undefined, { operation: 'set' });
    test.equal(result, true);
    test.deepEqual(storedFlags, []);
    test.done();
};

// ============================================================================
// status.js — line 30 branch: `Object.keys(query || {})` with undefined query
// Call status with no query argument so the `|| {}` fallback runs. With no
// query items, queryAttributes is empty and the command returns false.
// ============================================================================

const statusCommand = require('../lib/commands/status');

module.exports['Branches: status with undefined query uses {} fallback'] = async test => {
    let execCalled = false;
    const connection = createMockConnection({
        state: 2,
        exec: async () => {
            execCalled = true;
            return { next: () => {} };
        }
    });

    // query undefined -> Object.keys(query || {}) -> no attributes -> returns false
    const result = await statusCommand(connection, 'INBOX');
    test.equal(result, false);
    test.equal(execCalled, false);
    test.done();
};

// ============================================================================
// append.js — line 110 branch: responseCode `: ''` fallback.
// Tagged response has a section with length but section[0] has no string value,
// so the ternary picks '' and APPENDUID parsing is skipped.
// ============================================================================

const appendCommand = require('../lib/commands/append');

module.exports['Branches: append tagged section with non-string code uses empty fallback'] = async test => {
    const connection = createMockConnection({
        state: 2,
        mailbox: { path: 'INBOX', exists: 0, flags: new Set(), permanentFlags: new Set() },
        exec: async () => ({
            next: () => {},
            // section has length, but section[0].value is not a string -> responseCode = ''
            response: { attributes: [{ section: [{ value: 123 }, { value: '99' }] }] }
        }),
        // No EXISTS so map.seq stays unset; no UID search needed
        search: async () => []
    });

    const result = await appendCommand(connection, 'Sent', 'Subject: test\r\n\r\nbody');
    test.ok(result);
    test.equal(result.destination, 'Sent');
    // APPENDUID not parsed because responseCode === ''
    test.equal(result.uid, undefined);
    test.done();
};

// ============================================================================
// logout.js — line 33 / finally branch: successful LOGOUT where `response`
// exists and response.next is a function (the `response && typeof ...` true
// side of the finally cleanup). Ensures the try succeeds (return true) and the
// finally runs response.next() + close().
// ============================================================================

const logoutCommand = require('../lib/commands/logout');

module.exports['Branches: logout success runs response.next in finally'] = async test => {
    let nextCalled = false;
    let closeCalled = false;
    const connection = createMockConnection({
        state: 2,
        exec: async () => ({
            next: () => {
                nextCalled = true;
            }
        }),
        close: () => {
            closeCalled = true;
        }
    });

    const result = await logoutCommand(connection);
    test.equal(result, true);
    test.equal(nextCalled, true);
    test.equal(closeCalled, true);
    test.equal(connection.state, connection.states.LOGOUT);
    test.done();
};

module.exports['Branches: logout success with response lacking next() skips next call'] = async test => {
    let closeCalled = false;
    const connection = createMockConnection({
        state: 2,
        // exec resolves with a truthy response object that has NO next function,
        // exercising the `typeof response.next === 'function'` false side in finally.
        exec: async () => ({ response: { attributes: [] } }),
        close: () => {
            closeCalled = true;
        }
    });

    const result = await logoutCommand(connection);
    test.equal(result, true);
    test.equal(closeCalled, true);
    test.equal(connection.state, connection.states.LOGOUT);
    test.done();
};

// ============================================================================
// namespace.js — line 98 branch: getListPrefix LIST untagged where
// attributes[2] is missing, so prefix `|| ''` fallback is taken.
// Triggered via the no-NAMESPACE-capability fallback path.
// ============================================================================

const namespaceCommand = require('../lib/commands/namespace');

module.exports['Branches: namespace fallback LIST without prefix uses empty string'] = async test => {
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([['IMAP4rev1', true]]), // no NAMESPACE -> getListPrefix path
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                // attributes[0]=flags, [1]=delimiter, but NO [2] -> prefix falls back to ''
                await opts.untagged.LIST({
                    attributes: [[{ value: '\\Noselect' }], { value: '/' }]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await namespaceCommand(connection);
    test.ok(result);
    test.equal(result.prefix, '');
    test.equal(result.delimiter, '/');
    test.done();
};

// ============================================================================
// quota.js — line 88 branch: QUOTAROOT untagged where attributes[1] is missing,
// so quotaRoot resolves to `false` and map.quotaRoot is not set.
// ============================================================================

const quotaCommand = require('../lib/commands/quota');

module.exports['Branches: quota QUOTAROOT without root name yields false'] = async test => {
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([['QUOTA', true]]),
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'GETQUOTAROOT' && opts && opts.untagged) {
                if (opts.untagged.QUOTAROOT) {
                    // attributes[1] missing -> quotaRoot = false -> map.quotaRoot stays unset
                    await opts.untagged.QUOTAROOT({ attributes: [{ value: 'INBOX' }] });
                }
            }
            return { next: () => {} };
        }
    });

    const result = await quotaCommand(connection, 'INBOX');
    test.ok(result);
    test.equal(result.path, 'INBOX');
    test.equal(result.quotaRoot, undefined);
    test.done();
};

// ============================================================================
// fetch.js — line 234 branch: ETHROTTLE retry where err.throttleReset is set
// and larger than the computed backoff, so the `err.throttleReset` side of the
// delay ternary is taken. First exec throws ETHROTTLE, second succeeds.
// throttleReset is just above the 1000ms backoff to keep the test fast.
// ============================================================================

const fetchCommand = require('../lib/commands/fetch');

module.exports['Branches: fetch ETHROTTLE uses throttleReset delay then retries'] = async test => {
    let calls = 0;
    const connection = createMockConnection({
        state: 3,
        mailbox: { path: 'INBOX', exists: 1, flags: new Set(), permanentFlags: new Set(), noModseq: true },
        exec: async () => {
            calls++;
            if (calls === 1) {
                const err = new Error('throttled');
                err.code = 'ETHROTTLE';
                err.throttleReset = 1001; // > backoffDelay(1000) -> throttleReset branch taken
                err.responseText = 'throttled';
                throw err;
            }
            return { next: () => {}, response: { attributes: [] } };
        }
    });

    const result = await fetchCommand(connection, '1:*', { uid: true }, { uid: true });
    test.ok(result);
    test.equal(calls, 2);
    test.done();
};

// ============================================================================
// search.js — line 98 branch: `options = options || {}` with undefined options.
// Plain SEARCH ALL call without an options argument.
// ============================================================================

const searchCommand = require('../lib/commands/search');

module.exports['Branches: search with undefined options uses {} fallback'] = async test => {
    let execCmd = null;
    const connection = createMockConnection({
        state: 3,
        exec: async (cmd, attrs, opts) => {
            execCmd = cmd;
            if (opts && opts.untagged && opts.untagged.SEARCH) {
                await opts.untagged.SEARCH({ attributes: [{ value: '1' }, { value: '2' }] });
            }
            return { next: () => {} };
        }
    });

    // No options argument -> options || {} fallback; not UID -> plain SEARCH
    const result = await searchCommand(connection, true);
    test.deepEqual(result, [1, 2]);
    test.equal(execCmd, 'SEARCH');
    test.done();
};

// ============================================================================
// search.js — line 141 branch: `: 'SEARCH'` side of ESEARCH command name.
// ESEARCH path with options.uid falsy.
// search.js — line 150 branch: `|| attrs[start].type === 'LIST'` — the leading
// tag token is an object with type 'LIST' (not a plain Array), so the second
// operand of the OR is evaluated and used to skip it.
// ============================================================================

module.exports['Branches: search ESEARCH without uid emits SEARCH and skips LIST-typed tag'] = async test => {
    let execCmd = null;
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['ESEARCH', true]]),
        exec: async (cmd, attrs, opts) => {
            execCmd = cmd;
            if (opts && opts.untagged && opts.untagged.ESEARCH) {
                // attrs[0] is a LIST-typed object (not a plain Array) -> exercises
                // the `attrs[start].type === 'LIST'` branch on line 150.
                await opts.untagged.ESEARCH({
                    attributes: [{ type: 'LIST' }, { type: 'ATOM', value: 'COUNT' }, { type: 'ATOM', value: '7' }]
                });
            }
            return { next: () => {} };
        }
    });

    // returnOptions present + ESEARCH capability + options.uid falsy
    const result = await searchCommand(connection, true, { returnOptions: ['COUNT'] });
    test.equal(execCmd, 'SEARCH'); // not 'UID SEARCH'
    test.equal(result.count, 7);
    test.done();
};

// ============================================================================
// search.js — line 59 `: null` and line 60 `break;` branches:
// parseEsearchResponse PARTIAL where the value token is neither a plain Array
// nor an object with an `.attributes` array, so `items` is null and the loop
// breaks without setting result.partial.
// ============================================================================

module.exports['Branches: parseEsearchResponse PARTIAL with non-list value is ignored'] = test => {
    const parse = searchCommand.parseEsearchResponse;
    // PARTIAL followed by a plain ATOM (no array, no .attributes) -> items === null -> break
    const result = parse([
        { type: 'ATOM', value: 'PARTIAL' },
        { type: 'ATOM', value: 'notalist' }
    ]);
    test.equal(result.partial, undefined);
    test.done();
};

// ============================================================================
// select.js — line 38 branch: `: false` — after running LIST, the requested
// path is still not present in connection.folders, so folderListData is false.
// ============================================================================

const selectCommand = require('../lib/commands/select');

module.exports['Branches: select with folder list missing requested path sets folderListData false'] = async test => {
    const connection = createMockConnection({
        state: 2,
        folders: new Map(),
        run: async cmd => {
            if (cmd === 'LIST') {
                // Returns a folder that is NOT the requested 'INBOX' path
                return [{ path: 'Other', delimiter: '/' }];
            }
        },
        exec: async () => ({
            next: () => {},
            response: { attributes: [{ section: [{ type: 'ATOM', value: 'READ-WRITE' }] }] }
        }),
        emit: () => {}
    });

    const result = await selectCommand(connection, 'INBOX');
    test.ok(result);
    test.equal(result.path, 'INBOX');
    // No delimiter/specialUse copied since folderListData was false
    test.equal(result.delimiter, undefined);
    test.done();
};

// ============================================================================
// select.js — line 97 `: false` (PERMANENTFLAGS list entry not a string) and
// line 170 `: false` (FLAGS list entry not a string).
// ============================================================================

module.exports['Branches: select filters non-string flags in FLAGS and PERMANENTFLAGS'] = async test => {
    const connection = createMockConnection({
        state: 2,
        folders: new Map([['INBOX', { path: 'INBOX', delimiter: '/' }]]),
        run: async () => [],
        exec: async (cmd, attrs, opts) => {
            if (opts && opts.untagged) {
                if (opts.untagged.FLAGS) {
                    // A list containing a non-string flag (numeric value)
                    // -> exercises the `: false` filter on line 170.
                    await opts.untagged.FLAGS({ attributes: [[{ value: '\\Seen' }, { value: 42 }]] });
                }
                if (opts.untagged.OK) {
                    // PERMANENTFLAGS list with a non-string entry -> line 97 `: false`
                    await opts.untagged.OK({
                        attributes: [{ section: [{ type: 'ATOM', value: 'PERMANENTFLAGS' }, [{ value: '\\*' }, { value: 7 }]] }]
                    });
                }
            }
            return {
                next: () => {},
                response: { attributes: [{ section: [{ type: 'ATOM', value: 'READ-WRITE' }] }] }
            };
        },
        emit: () => {}
    });

    const result = await selectCommand(connection, 'INBOX');
    test.ok(result);
    // Non-string flag filtered out
    test.ok(result.flags.has('\\Seen'));
    test.equal(result.flags.size, 1);
    // Non-string permanent flag filtered out
    test.ok(result.permanentFlags.has('\\*'));
    test.equal(result.permanentFlags.size, 1);
    test.done();
};

// Regression: a malformed `* FLAGS` untagged response (empty attributes, or a
// non-array attributes[0]) must be ignored, not crash on `attributes[0].map(...)`.
module.exports['Branches: select FLAGS guard ignores malformed attributes without throwing'] = async test => {
    test.expect(4);

    const makeConn = flagsAttributes =>
        createMockConnection({
            state: 2,
            folders: new Map([['INBOX', { path: 'INBOX', delimiter: '/' }]]),
            run: async () => [],
            exec: async (cmd, attrs, opts) => {
                if (opts && opts.untagged && opts.untagged.FLAGS) {
                    await opts.untagged.FLAGS({ attributes: flagsAttributes });
                }
                return {
                    next: () => {},
                    response: { attributes: [{ section: [{ type: 'ATOM', value: 'READ-WRITE' }] }] }
                };
            },
            emit: () => {}
        });

    // Empty attributes (server sent `* FLAGS` with no list): bail on the length guard.
    const emptyResult = await selectCommand(makeConn([]), 'INBOX');
    test.ok(emptyResult);
    test.equal(emptyResult.flags, undefined);

    // attributes[0] present but not an array: bail on the Array.isArray guard.
    const nonArrayResult = await selectCommand(makeConn([{ value: '\\Seen' }]), 'INBOX');
    test.ok(nonArrayResult);
    test.equal(nonArrayResult.flags, undefined);

    test.done();
};

// ============================================================================
// list.js — multiple branches.
// ============================================================================

const listCommand = require('../lib/commands/list');

// list.js line 47 branch: statusQuery key with a falsy value -> `return;`.
module.exports['Branches: list statusQuery with falsy value is skipped'] = async test => {
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([
            ['LIST-STATUS', true],
            ['SPECIAL-USE', true]
        ]),
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                await opts.untagged.LIST({
                    attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                });
            }
            return { next: () => {} };
        }
    });

    // messages:false is skipped (line 47), unseen:true is kept
    const result = await listCommand(connection, '', '*', {
        statusQuery: { messages: false, unseen: true }
    });
    test.ok(Array.isArray(result));
    test.done();
};

// list.js lines 128/129 (LIST untagged attributes[2] missing -> '' fallbacks),
// 162 (parentPath '' when no delimiter) and 163 (parent [entry.path] when no
// delimiter). LIST entry with a NIL delimiter and no name attribute.
module.exports['Branches: list LIST entry without delimiter or name uses fallbacks'] = async test => {
    const connection = createMockConnection({
        state: 2,
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                // attributes[1] (delimiter) is NIL (null) and attributes[2] (name) missing
                await opts.untagged.LIST({
                    attributes: [[{ value: '\\Noselect' }], null]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await listCommand(connection, '', '*');
    test.ok(Array.isArray(result));
    test.equal(result.length, 1);
    // path defaulted to '' (no attributes[2]); no delimiter -> parentPath '' and parent ['']
    test.equal(result[0].path, '');
    test.equal(result[0].parentPath, '');
    test.done();
};

// list.js line 184 (`: false` when STATUS attributes[1] not an array) and
// line 185 (`if (!statusList || !statusPath) return;`).
module.exports['Branches: list STATUS with non-array values is ignored'] = async test => {
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([
            ['LIST-STATUS', true],
            ['SPECIAL-USE', true]
        ]),
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'LIST' && opts && opts.untagged) {
                if (opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                    });
                }
                if (opts.untagged.STATUS) {
                    // attributes[0] missing -> statusPath '' fallback (line 183); and
                    // attributes[1] is not an array -> statusList false -> early return (line 185)
                    await opts.untagged.STATUS({ attributes: [undefined, { value: 'notanarray' }] });
                }
            }
            return { next: () => {} };
        }
    });

    const result = await listCommand(connection, '', '*', { statusQuery: { messages: true } });
    test.ok(Array.isArray(result));
    // No status attached because the STATUS untagged response was ignored
    const inbox = result.find(e => e.path === 'INBOX');
    test.ok(inbox);
    test.done();
};

// list.js line 203 (`: false` when STATUS key value is not a string) and
// line 206 (`if (!key || !entry || typeof entry.value !== 'string') return;`).
module.exports['Branches: list STATUS with non-string key/value pairs skipped'] = async test => {
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([
            ['LIST-STATUS', true],
            ['SPECIAL-USE', true]
        ]),
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'LIST' && opts && opts.untagged) {
                if (opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                    });
                }
                if (opts.untagged.STATUS) {
                    // key token has a non-string value (line 203 -> key = false),
                    // then the value token also has a non-string value (line 206 guard).
                    await opts.untagged.STATUS({
                        attributes: [{ value: 'INBOX' }, [{ value: 999 }, { value: 12 }]]
                    });
                }
            }
            return { next: () => {} };
        }
    });

    const result = await listCommand(connection, '', '*', { statusQuery: { messages: true } });
    test.ok(Array.isArray(result));
    test.done();
};

// list.js line 231 / 269 branches: `mailbox || ''` empty side. Call list with
// an undefined mailbox argument so both the LIST and LSUB calls take the ''
// fallback for the mailbox pattern.
module.exports['Branches: list with undefined mailbox pattern uses empty fallback'] = async test => {
    let listMailboxArg;
    let lsubMailboxArg;
    const connection = createMockConnection({
        state: 2,
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'LIST') {
                listMailboxArg = attrs[1];
                if (opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                    });
                }
            }
            if (cmd === 'LSUB') {
                lsubMailboxArg = attrs[1];
            }
            return { next: () => {} };
        }
    });

    // mailbox undefined -> `mailbox || ''` fallback used at lines 231 and 269
    const result = await listCommand(connection, '', undefined);
    test.ok(Array.isArray(result));
    test.equal(listMailboxArg, '');
    test.equal(lsubMailboxArg, '');
    test.done();
};

// list.js lines 278/279 (LSUB attributes[2] missing -> '' fallbacks) and
// lines 293/294 (LSUB entry without delimiter -> parentPath '' / parent [path]).
module.exports['Branches: list LSUB entry without delimiter or name uses fallbacks'] = async test => {
    const connection = createMockConnection({
        state: 2,
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                await opts.untagged.LIST({
                    attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                });
            }
            if (cmd === 'LSUB' && opts && opts.untagged && opts.untagged.LSUB) {
                // delimiter NIL and no name attribute -> '' fallbacks + no-delimiter parent logic
                await opts.untagged.LSUB({
                    attributes: [[{ value: '\\HasNoChildren' }], null]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await listCommand(connection, '', '*');
    test.ok(Array.isArray(result));
    test.done();
};

// list.js line 342 branch: `if (!a.specialUse && b.specialUse) return 1;`.
// To make V8's sort invoke the comparator with a non-special `a` and a
// special-use `b`, the special-use entry must come FIRST in insertion order,
// followed by several plain folders.
module.exports['Branches: list sort returns 1 when a lacks specialUse but b has it'] = async test => {
    const connection = createMockConnection({
        state: 2,
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                // INBOX (name-based \\Inbox special use) emitted FIRST, then plain folders.
                await opts.untagged.LIST({
                    attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                });
                await opts.untagged.LIST({
                    attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'AAA' }]
                });
                await opts.untagged.LIST({
                    attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'BBB' }]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await listCommand(connection, '', '*');
    test.ok(Array.isArray(result));
    // INBOX (special use) sorts before the plain folders
    test.equal(result[0].path, 'INBOX');
    test.deepEqual(
        result.slice(1).map(e => e.path),
        ['AAA', 'BBB']
    );
    test.done();
};

// ============================================================================
// idle.js — NOOP fallback path (no IDLE capability).
// Covers line 216 (`case 'NOOP'`) and line 224 (`maxIdleTime ?` truthy side).
// We trigger one NOOP poll, then break the loop via preCheck().
// ============================================================================

const idleCommand = require('../lib/commands/idle');

module.exports['Branches: idle NOOP fallback runs poll then breaks via preCheck'] = async test => {
    test.expect(1);
    let noopCalled = false;
    let resolveNoop;
    let noopRan = new Promise(resolve => {
        resolveNoop = resolve;
    });
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['IMAP4rev1', true]]), // no IDLE -> NOOP polling path
        currentSelectCommand: { command: 'SELECT', arguments: [{ type: 'ATOM', value: 'INBOX' }] },
        missingIdleCommand: 'NOOP',
        exec: async cmd => {
            if (cmd === 'NOOP') {
                noopCalled = true;
                resolveNoop();
            }
            return { next: () => {} };
        }
    });

    // maxIdleTime provided -> exercises `maxIdleTime ? Math.min(...) : NOOP_INTERVAL` truthy side
    const idlePromise = idleCommand(connection, 60000);

    // Wait until the first NOOP poll has actually run, then cross a macrotask
    // boundary so the loop's .then() has armed its next-poll setTimeout before we
    // break out. This guarantees preCheck()'s clearTimeout clears the armed timer,
    // so no 60s timer leaks and the poll loop stops deterministically.
    await noopRan;
    await new Promise(resolve => setImmediate(resolve));
    await connection.preCheck();

    await idlePromise;
    test.equal(noopCalled, true);
    test.done();
};

// ============================================================================
// idle.js — IDLE path with currentLock set, exercising the `?.lockId` optional
// chaining truthy sides (lines 37, 62, 83, 101) and the cleanup while-loop
// (line 109) that drains preCheckWaitQueue. We request a break (preCheck)
// before the server acknowledges with the "+" continuation, so that the
// onPlusTag handler invokes preCheck() which sends DONE and drains the queue.
// ============================================================================

module.exports['Branches: idle IDLE path with currentLock drives preCheck and cleanup'] = async test => {
    let doneWritten = false;
    let onPlusTagFn = null;
    let resolveExec = null;

    // Deferred that resolves once runIdle has entered exec (preCheck registered).
    let resolveEntered;
    const execEntered = new Promise(resolve => {
        resolveEntered = resolve;
    });

    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['IDLE', true]]),
        currentLock: { lockId: 'lock-1' }, // makes `currentLock?.lockId` take the defined (truthy) side
        write: data => {
            if (data === 'DONE') {
                doneWritten = true;
            }
        },
        exec: (cmd, attrs, opts) => {
            // Capture onPlusTag, signal entry, and keep IDLE pending until resolved below.
            onPlusTagFn = opts.onPlusTag;
            resolveEntered();
            return new Promise(resolve => {
                resolveExec = () => resolve({ next: () => {}, response: { attributes: [] } });
            });
        }
    });

    const idlePromise = idleCommand(connection);

    await execEntered;

    // Request an IDLE break before the "+" continuation. canEnd is still false,
    // so DONE is not sent yet; a waiter is queued in preCheckWaitQueue.
    const breakPromise = typeof connection.preCheck === 'function' ? connection.preCheck() : Promise.resolve();

    // Simulate the server "+" continuation. doneRequested is already true, so
    // onPlusTag sets canEnd and calls preCheck(), which writes DONE and drains the
    // queue (covers the `?.lockId` truthy sides and the preCheckWaitQueue drain).
    if (onPlusTagFn) {
        await onPlusTagFn();
    }

    // Let the IDLE exec resolve so runIdle proceeds to its cleanup block.
    if (resolveExec) {
        resolveExec();
    }

    await breakPromise;
    await idlePromise;

    test.equal(doneWritten, true);
    test.done();
};

// ============================================================================
// idle.js — lines 109-112: the cleanup-block while-loop that drains
// preCheckWaitQueue. This runs when a break was requested but DONE was never
// sent (server never sent the "+" continuation, so canEnd stayed false and
// preCheck remained registered). When exec then resolves, runIdle's cleanup
// finds preCheck === connectionPreCheck and drains the still-queued waiters.
// ============================================================================

module.exports['Branches: idle cleanup drains queued waiters when DONE never sent'] = async test => {
    let onPlusTagFn = null;
    let resolveExec = null;
    let resolveEntered;
    const execEntered = new Promise(resolve => {
        resolveEntered = resolve;
    });

    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['IDLE', true]]),
        currentLock: { lockId: 'lock-9' }, // exercises `currentLock?.lockId` truthy side in cleanup trace
        write: () => {}, // would only be called if DONE were sent; it never is here
        exec: (cmd, attrs, opts) => {
            onPlusTagFn = opts.onPlusTag;
            resolveEntered();
            return new Promise(resolve => {
                resolveExec = () => resolve({ next: () => {}, response: { attributes: [] } });
            });
        }
    });

    const idlePromise = idleCommand(connection);
    await execEntered;

    // Request a break: canEnd is still false (no "+" continuation yet), so DONE is
    // NOT sent and connection.preCheck stays registered. The waiter is queued.
    const breakPromise = connection.preCheck();

    // Resolve exec WITHOUT invoking onPlusTag, so runIdle reaches its cleanup block
    // with preCheck still === connectionPreCheck and the queue non-empty -> drains it.
    test.ok(typeof onPlusTagFn === 'function');
    resolveExec();

    await breakPromise; // resolves only if the cleanup drain ran
    await idlePromise;
    test.done();
};

// ============================================================================
// idle.js — line 88 catch: the onPlusTag handler wraps `await preCheck()` in a
// try/catch. We make connection.write('DONE') throw so that preCheck rejects and
// the catch on line 88 logs the error. A break is requested before the "+"
// continuation so that onPlusTag invokes preCheck() (which calls write).
// ============================================================================

module.exports['Branches: idle onPlusTag catches preCheck error when DONE write throws'] = async test => {
    let onPlusTagFn = null;
    let resolveExec = null;
    let resolveEntered;
    const execEntered = new Promise(resolve => {
        resolveEntered = resolve;
    });

    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['IDLE', true]]),
        write: data => {
            if (data === 'DONE') {
                throw new Error('socket write failed');
            }
        },
        exec: (cmd, attrs, opts) => {
            onPlusTagFn = opts.onPlusTag;
            resolveEntered();
            return new Promise(resolve => {
                resolveExec = () => resolve({ next: () => {}, response: { attributes: [] } });
            });
        }
    });

    const idlePromise = idleCommand(connection);
    await execEntered;

    // Request a break before the "+" continuation: queues a waiter, sets
    // doneRequested true, but canEnd is still false so write isn't called yet.
    const breakPromise = connection.preCheck();

    // Server "+" continuation: onPlusTag sets canEnd and calls preCheck(), which
    // attempts connection.write('DONE') -> throws -> caught by the line 88 catch.
    await onPlusTagFn();

    // The break never resolves because DONE failed; resolve exec so IDLE completes,
    // and detach the rejected break handler to avoid an unhandled rejection.
    resolveExec();
    breakPromise.catch(() => {});

    await idlePromise;
    test.done();
};

// ============================================================================
// authenticate.js — error paths in authOauth (line 88), authLogin (line 136)
// and authPlain (line 173). Each calls handleAuthError when exec rejects.
// We make exec reject so the catch -> handleAuthError -> throw path runs.
// ============================================================================

const authenticateCommand = require('../lib/commands/authenticate');

module.exports['Branches: authenticate OAuth error path calls handleAuthError'] = async test => {
    const connection = createMockConnection({
        state: 1, // NOT_AUTHENTICATED
        servername: 'imap.example.com',
        capabilities: new Map([['AUTH=OAUTHBEARER', true]]),
        exec: async () => {
            const err = new Error('auth failed');
            err.response = { attributes: [] };
            throw err;
        }
    });

    test.expect(1);
    try {
        await authenticateCommand(connection, 'user@example.com', { accessToken: 'token123' });
        test.ok(false, 'should have thrown');
    } catch (err) {
        test.equal(err.authenticationFailed, true);
    }
    test.done();
};

module.exports['Branches: authenticate PLAIN error path calls handleAuthError'] = async test => {
    const connection = createMockConnection({
        state: 1,
        capabilities: new Map([['AUTH=PLAIN', true]]),
        exec: async () => {
            const err = new Error('auth failed');
            err.response = { attributes: [] };
            throw err;
        }
    });

    test.expect(1);
    try {
        await authenticateCommand(connection, 'user@example.com', { password: 'secret' });
        test.ok(false, 'should have thrown');
    } catch (err) {
        test.equal(err.authenticationFailed, true);
    }
    test.done();
};

module.exports['Branches: authenticate LOGIN error path calls handleAuthError'] = async test => {
    const connection = createMockConnection({
        state: 1,
        capabilities: new Map([['AUTH=LOGIN', true]]), // no AUTH=PLAIN -> LOGIN chosen
        exec: async () => {
            const err = new Error('auth failed');
            err.response = { attributes: [] };
            throw err;
        }
    });

    test.expect(1);
    try {
        await authenticateCommand(connection, 'user@example.com', { password: 'secret' });
        test.ok(false, 'should have thrown');
    } catch (err) {
        test.equal(err.authenticationFailed, true);
    }
    test.done();
};
