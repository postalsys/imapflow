/* eslint-disable new-cap */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import searchCommand from '../../src/commands/search.js';
import expungeCommand from '../../src/commands/expunge.js';
import listCommand from '../../src/commands/list.js';
import selectCommand from '../../src/commands/select.js';
import statusCommand from '../../src/commands/status.js';
import appendCommand from '../../src/commands/append.js';
import quotaCommand from '../../src/commands/quota.js';
import { ImapFlow } from '../../src/imap-flow.js';
import { canUseFlag } from '../../src/tools.js';
import type { MailboxObject } from '../../src/types.js';
import { createMockConnection } from '../fixtures/mock-connection.js';

// BigInt() is a standard JS function but triggers new-cap rule

// ============================================
// Untrusted response value handling
// ============================================
// Servers control every value in these responses. Each test below pins a value the client
// must refuse to store, or a malformed shape it must survive without losing the response.

const selectWithOkCodes = (sections: any) =>
    createMockConnection({
        state: 2, // AUTHENTICATED
        folders: new Map([['INBOX', { path: 'INBOX', delimiter: '/' }]]),
        run: async () => [],
        exec: async (cmd: any, attrs: any, opts: any) => {
            if (opts && opts.untagged && opts.untagged.OK) {
                for (let section of sections) {
                    await opts.untagged.OK({ attributes: [{ section }] });
                }
            }
            return {
                next: () => {},
                response: { attributes: [{ section: [{ type: 'ATOM', value: 'READ-WRITE' }] }] }
            };
        },
        emit: () => {}
    });

describe('commands/security-regression', () => {
    it('Commands: quota ignores prototype-chain and fixed-field resource names', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['QUOTA', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.QUOTA) {
                    await opts.untagged.QUOTA({
                        attributes: [
                            { value: '' },
                            [
                                { value: '__PROTO__' },
                                { value: '10' },
                                { value: '100' },
                                { value: 'CONSTRUCTOR' },
                                { value: '1' },
                                { value: '2' },
                                { value: 'PATH' },
                                { value: '3' },
                                { value: '4' },
                                { value: 'STORAGE' },
                                { value: '250' },
                                { value: '500' }
                            ]
                        ]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await quotaCommand(connection, 'INBOX');
        // Capture before cleaning up: deleting first would erase exactly the evidence the
        // assertion looks for, and the test would then pass with the guard removed. The cleanup
        // still has to happen so a regression cannot leak into the rest of the suite.
        let leaked = ['usage', 'limit', 'status'].filter(key => Object.hasOwn(Object.prototype, key));
        delete (Object.prototype as any).usage;
        delete (Object.prototype as any).limit;
        delete (Object.prototype as any).status;
        assert.deepEqual(leaked, [], 'Object.prototype must stay clean');
        assert.equal((result as any).path, 'INBOX', 'the fixed path field must not be overwritten');
        assert.ok(!Object.prototype.hasOwnProperty.call(result, 'constructor'));
        assert.equal((result as any)!.storage.usage, 250 * 1024);
        assert.equal((result as any)!.storage.limit, 500 * 1024);
    });
    it('Commands: select ignores unknown response codes on the mailbox object', async () => {
        const connection: any = createMockConnection({
            state: 2, // AUTHENTICATED
            folders: new Map([['INBOX', { path: 'INBOX', delimiter: '/' }]]),
            run: async () => [],
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.untagged) {
                    if (opts.untagged.OK) {
                        // A response code the client does not know must not become a mailbox
                        // property: "PATH" would otherwise overwrite mailbox.path (defeating the
                        // DELETE/RENAME guards), and "__PROTO__" with a list value would replace
                        // the object's prototype
                        await opts.untagged.OK({
                            attributes: [{ section: [{ type: 'ATOM', value: 'PATH' }, { value: 'INBOX.evil' }] }]
                        });
                        await opts.untagged.OK({
                            attributes: [{ section: [{ type: 'ATOM', value: '__PROTO__' }, [{ value: 'polluted' }]] }]
                        });
                        await opts.untagged.OK({
                            attributes: [{ section: [{ type: 'ATOM', value: 'UIDNEXT' }, { value: '1000' }] }]
                        });
                        // malformed codes must not crash the handler or corrupt state either:
                        // a NIL key, a NIL value, and a UIDNEXT digit run that overflows to Infinity
                        await opts.untagged.OK({
                            attributes: [{ section: [null] }]
                        });
                        await opts.untagged.OK({
                            attributes: [{ section: [{ type: 'ATOM', value: 'UIDNEXT' }, null] }]
                        });
                        await opts.untagged.OK({
                            attributes: [{ section: [{ type: 'ATOM', value: 'UIDNEXT' }, { value: '9'.repeat(400) }] }]
                        });
                    }
                    if (opts.untagged.EXISTS) {
                        // an overflowing count must be ignored, not stored as Infinity
                        await opts.untagged.EXISTS({ command: '9'.repeat(400) });
                    }
                }
                return {
                    next: () => {},
                    response: { attributes: [{ section: [{ type: 'ATOM', value: 'READ-WRITE' }] }] }
                };
            },
            emit: () => {}
        });

        const result: any = await selectCommand(connection, 'INBOX');
        assert.equal(result.path, 'INBOX', 'a PATH response code must not overwrite mailbox.path');
        assert.equal(result!.uidNext, 1000, 'malformed UIDNEXT values must not replace a good one');
        assert.equal(result!.exists, undefined, 'an overflowing EXISTS count must be ignored');
        assert.equal((result as any)!.polluted, undefined);
        // A "__proto__" key with a list value replaces the object's prototype rather than creating
        // an own property, so the own-property check alone would hold with the guard removed too -
        // the prototype identity is what actually detects it
        assert.equal(Object.getPrototypeOf(result), Object.prototype, 'the mailbox object must keep its prototype');
        assert.ok(!Object.prototype.hasOwnProperty.call(result, '__proto__'));
    });
    it('Commands: downloadMany ignores prototype-chain part keys', async () => {
        // The server chooses the BODY[...] keys in its FETCH answers: without a guard a
        // "__proto__" key wrote attacker-controlled content onto Object.prototype
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });
        client.mailbox = { path: 'INBOX' } as MailboxObject;
        (client as any).fetchOne = async () => ({
            bodyParts: new Map([
                ['__proto__', Buffer.from('polluted')],
                ['2.mime', Buffer.from('Content-Type: text/plain\r\n\r\n')],
                ['2', Buffer.from('real content')]
            ])
        });

        let result: any = await client.downloadMany('1', ['2']);
        // Capture before cleaning up: deleting first would erase exactly the evidence the
        // assertion looks for, and the test would then pass with the guard removed
        let leaked = Object.hasOwn(Object.prototype, 'content') || Object.hasOwn(Object.prototype, 'meta');
        delete (Object.prototype as any).content;
        delete (Object.prototype as any).meta;
        assert.equal(leaked, false, 'Object.prototype must stay clean');
        assert.ok(result['2']);
        assert.equal(result['2'].content.toString(), 'real content');
        assert.equal(result['2'].meta.contentType, 'text/plain');
    });
    it('Commands: select leaves permanentFlags unset for a NIL PERMANENTFLAGS', async () => {
        // An empty Set is not the same as "unset": canUseFlag() treats unset as permissive and an
        // empty set as deny-all, which would silently turn every later flag update into a no-op
        const result: any = await selectCommand(selectWithOkCodes([[{ type: 'ATOM', value: 'PERMANENTFLAGS' }, null]]) as any, 'INBOX');
        assert.equal(result.permanentFlags, undefined, 'a NIL value must not produce an empty flag set');
        assert.ok(canUseFlag(result, '\\Seen'), 'flag updates must stay permitted');
    });
    it('Commands: select ignores an unparenthesized PERMANENTFLAGS value', async () => {
        // new Set('\\Seen') would be a set of the individual characters
        const result: any = await selectCommand(selectWithOkCodes([[{ type: 'ATOM', value: 'PERMANENTFLAGS' }, { value: '\\Seen' }]]) as any, 'INBOX');
        assert.equal(result.permanentFlags, undefined);
        assert.ok(canUseFlag(result, '\\Seen'));
    });
    it('Commands: select survives NIL entries inside a PERMANENTFLAGS list', async () => {
        const result: any = await selectCommand(
            selectWithOkCodes([[{ type: 'ATOM', value: 'PERMANENTFLAGS' }, [{ value: '\\Seen' }, null, { value: '\\Draft' }]]]) as any,
            'INBOX'
        );
        assert.deepEqual((Array.from as any)(result.permanentFlags), ['\\Seen', '\\Draft']);
    });
    it('Commands: select survives NIL entries inside a FLAGS response', async () => {
        const connection: any = createMockConnection({
            state: 2,
            folders: new Map([['INBOX', { path: 'INBOX', delimiter: '/' }]]),
            run: async () => [],
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.FLAGS) {
                    await opts.untagged.FLAGS({ attributes: [[{ value: '\\Seen' }, null, { value: '\\Flagged' }]] });
                }
                return { next: () => {}, response: { attributes: [] } };
            },
            emit: () => {}
        });

        const result: any = await selectCommand(connection, 'INBOX');
        assert.deepEqual((Array.from as any)(result.flags), ['\\Seen', '\\Flagged'], 'a NIL entry must not cost the whole flag list');
    });
    it('Commands: select handles a tagged OK carrying no response text', async () => {
        // "A1 OK" parses to an object with no `attributes` property at all. Reading through it in
        // the command body would land in the outer catch, which tears down the mailbox state the
        // server has actually selected and rejects the caller with a TypeError.
        const connection: any = createMockConnection({
            state: 2,
            folders: new Map([['INBOX', { path: 'INBOX', delimiter: '/' }]]),
            run: async () => [],
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.EXISTS) {
                    await opts.untagged.EXISTS({ command: '42' });
                }
                return { next: () => {}, response: { tag: 'A1', command: 'OK' } };
            },
            emit: () => {}
        });

        const result: any = await selectCommand(connection, 'INBOX');
        assert.equal(result.path, 'INBOX');
        assert.equal(result!.exists, 42, 'collected mailbox data must survive');
        assert.equal(result!.readOnly, undefined);
        assert.equal(connection.state, connection.states.SELECTED, 'the mailbox must stay selected');
    });
    it('Commands: select exposes UNSEEN and APPENDLIMIT', async () => {
        const result: any = await selectCommand(
            selectWithOkCodes([
                [{ type: 'ATOM', value: 'UNSEEN' }, { value: '12' }],
                [{ type: 'ATOM', value: 'APPENDLIMIT' }, { value: '35651584' }]
            ]) as any,
            'INBOX'
        );
        assert.equal(result.unseen, 12);
        assert.equal(result!.appendlimit, 35651584);
    });
    it('Commands: select drops an unusable HIGHESTMODSEQ instead of storing it raw', async () => {
        // A non-numeric string stored in a BigInt field compares false in both directions, so the
        // value could never advance again and CONDSTORE/QRESYNC delta sync would stop for good
        for (let bad of ['none', '1e5', '-1', '', '9'.repeat(20)]) {
            const result: any = await selectCommand(selectWithOkCodes([[{ type: 'ATOM', value: 'HIGHESTMODSEQ' }, { value: bad }]]) as any, 'INBOX');
            assert.equal(result.highestModseq, undefined, `HIGHESTMODSEQ ${JSON.stringify(bad)} must be dropped`);
        }

        const good: any = await selectCommand(selectWithOkCodes([[{ type: 'ATOM', value: 'HIGHESTMODSEQ' }, { value: '9122' }]]) as any, 'INBOX');
        assert.equal(good.highestModseq, 9122n);
    });
    it('Commands: select accepts only decimal UIDNEXT values', async () => {
        for (let bad of ['0x10', '1e3', '  12  ', '-5', '1.5']) {
            const result: any = await selectCommand(selectWithOkCodes([[{ type: 'ATOM', value: 'UIDNEXT' }, { value: bad }]]) as any, 'INBOX');
            assert.equal(result.uidNext, undefined, `UIDNEXT ${JSON.stringify(bad)} must be dropped`);
        }

        const good: any = await selectCommand(selectWithOkCodes([[{ type: 'ATOM', value: 'UIDNEXT' }, { value: '1000' }]]) as any, 'INBOX');
        assert.equal(good.uidNext, 1000);
    });
    it('Commands: append survives a malformed APPENDUID', async () => {
        // BigInt('1e5') throws where isNaN('1e5') passes, and append rethrows - the message is
        // already stored at that point, so a retrying caller would duplicate it
        const connection: any = createMockConnection({
            state: 2,
            folders: new Map([['INBOX', { path: 'INBOX', delimiter: '/' }]]),
            exec: async () => ({
                next: () => {},
                response: {
                    attributes: [
                        {
                            section: [{ type: 'ATOM', value: 'APPENDUID' }, { value: '1e5' }, { value: '7' }]
                        }
                    ]
                }
            })
        });

        const result = await appendCommand(connection, 'INBOX', Buffer.from('test'));
        assert.ok(result, 'append must not reject on an unusable APPENDUID');
        assert.equal(result.uidValidity, undefined, 'the unusable uidValidity is dropped');
        assert.equal(result.uid, 7, 'the usable uid is still reported');
    });
    it('Commands: append ignores an overflowing EXISTS count', async () => {
        // Number('9'.repeat(400)) is Infinity, and resolveRange('*') would then compile the literal
        // string "Infinity" into every later range-based command
        let emitted: any = [];
        const connection: any = createMockConnection({
            state: 3,
            mailbox: { path: 'INBOX', exists: 5, flags: new Set(), permanentFlags: new Set(['\\*']) },
            folders: new Map([['INBOX', { path: 'INBOX', delimiter: '/' }]]),
            emit: (name: any, payload: any) => emitted.push([name, payload]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.EXISTS) {
                    await opts.untagged.EXISTS({ command: '9'.repeat(400) });
                }
                return { next: () => {}, response: { attributes: [] } };
            }
        });

        await appendCommand(connection, 'INBOX', Buffer.from('test'));
        assert.equal(connection.mailbox.exists, 5, 'the live message count must be left alone');
        assert.equal(emitted.filter((entry: any) => entry[0] === 'exists').length, 0, 'no exists event may be emitted for an unusable count');
    });
    it('Commands: expunge survives a malformed HIGHESTMODSEQ', async () => {
        const connection: any = createMockConnection({
            state: 3,
            mailbox: { path: 'INBOX', highestModseq: 100n },
            exec: async () => ({
                next: () => {},
                response: {
                    attributes: [{ section: [{ type: 'ATOM', value: 'HIGHESTMODSEQ' }, { value: '1e5' }] }]
                }
            })
        });

        const result = await expungeCommand(connection, '1:*', {});
        assert.equal(result, true, 'the expunge did happen, so it must not be reported as failed');
        assert.equal(connection.mailbox.highestModseq, 100n, 'the unusable value is not stored');
    });
    it('Commands: status skips one malformed field and keeps the rest', async () => {
        const connection: any = createMockConnection({
            state: 2,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.STATUS) {
                    await opts.untagged.STATUS({
                        attributes: [
                            { value: 'INBOX' },
                            [{ value: 'MESSAGES' }, { value: '1e5' }, { value: 'UIDNEXT' }, { value: '10' }, { value: 'UIDVALIDITY' }, { value: '99' }]
                        ]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await statusCommand(connection, 'INBOX', { messages: true, uidNext: true, uidValidity: true });
        assert.equal(result.messages, undefined, 'the unusable field is dropped');
        assert.equal((result as any).uidNext, 10, 'later fields must still be parsed');
        assert.equal((result as any).uidValidity, 99n);
    });
    it('Commands: status ignores an overflowing MESSAGES count for the selected mailbox', async () => {
        let emitted: any = [];
        const connection: any = createMockConnection({
            state: 3,
            mailbox: { path: 'INBOX', exists: 5 },
            emit: (name: any, payload: any) => emitted.push([name, payload]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.STATUS) {
                    await opts.untagged.STATUS({
                        attributes: [{ value: 'INBOX' }, [{ value: 'MESSAGES' }, { value: '9'.repeat(400) }]]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await statusCommand(connection, 'INBOX', { messages: true });
        assert.equal(result.messages, undefined);
        assert.equal(connection.mailbox.exists, 5, 'the live message count must be left alone');
        assert.equal(emitted.filter((entry: any) => entry[0] === 'exists').length, 0);
    });
    it('Commands: search drops out-of-range values from an untagged SEARCH', async () => {
        // isNaN() passes '1e400' (Infinity), '-3' and '2.5'; a single one of those makes the
        // sequence set compiled from this result invalid and fails the caller's follow-up command
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.SEARCH) {
                    await opts.untagged.SEARCH({
                        attributes: [
                            { value: '1e400' },
                            { value: '-3' },
                            { value: '2.5' },
                            { value: '0' },
                            null, // a parsed NIL
                            { value: ['1'] }, // a parenthesized value where a number belongs
                            { value: '2' },
                            { value: '7' }
                        ]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await searchCommand(connection, { all: true }, {});
        assert.deepEqual(result, [2, 7], 'only valid nz-numbers may enter the result set');
    });
    it('Commands: downloadMany yields a part that arrived without its MIME headers', async () => {
        // A server may legally answer with fewer items than were requested. One part missing its
        // companion BODY[<part>.MIME] must not cost the caller the whole download.
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' },
            logger: false
        });
        client.mailbox = { path: 'INBOX' } as MailboxObject;
        (client as any).fetchOne = async () => ({
            bodyParts: new Map([['2', Buffer.from('real content')]])
        });

        let result: any = await client.downloadMany('1', ['2']);
        assert.equal(result['2'].content.toString(), 'real content');
        assert.deepEqual(result['2'].meta, {}, 'a part with no MIME headers still gets a meta object');
    });
    it('Commands: list keeps a LIST-STATUS block when one field is malformed', async () => {
        // BigInt('1e5') throws where isNaN('1e5') passes, and the throw happened before the block
        // was stored - so one bad field made the whole mailbox's status vanish from the listing
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['LIST-STATUS', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST') {
                    if (opts && opts.untagged && opts.untagged.LIST) {
                        await opts.untagged.LIST({
                            attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                        });
                    }
                    if (opts && opts.untagged && opts.untagged.STATUS) {
                        await opts.untagged.STATUS({
                            attributes: [
                                { value: 'INBOX' },
                                [{ value: 'HIGHESTMODSEQ' }, { value: '1e5' }, { value: 'MESSAGES' }, { value: '10' }, { value: 'UNSEEN' }, { value: '5' }]
                            ]
                        });
                    }
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*', { statusQuery: { messages: true, unseen: true, highestModseq: true } });
        const inbox = result.find(entry => entry.path === 'INBOX');
        assert.ok(inbox && inbox.status, 'the status block must survive one unusable field');
        assert.equal(inbox.status.highestModseq, undefined, 'the unusable field is dropped');
        assert.equal(inbox.status.messages, 10);
        assert.equal(inbox.status.unseen, 5);
    });
    it('Commands: select accepts an unparenthesized MAILBOXID', async () => {
        // RFC 8474 sends the id as a parenthesized list, but servers in the wild send it bare too
        const result: any = await selectCommand(selectWithOkCodes([[{ type: 'ATOM', value: 'MAILBOXID' }, { value: 'abc123' }]]) as any, 'INBOX');
        assert.equal(result.mailboxId, 'abc123');
    });
    it('Commands: quota ignores a NIL resource value', async () => {
        // A parsed NIL is null, which must not be recorded as a usage of 0
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['QUOTA', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'GETQUOTAROOT' && opts && opts.untagged && opts.untagged.QUOTA) {
                    await opts.untagged.QUOTA({
                        attributes: [{ value: 'root' }, [{ value: 'STORAGE' }, null, { value: '500' }]]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await quotaCommand(connection, 'INBOX');
        assert.ok(result, 'the command must actually run');
        assert.equal((result.storage as any).usage, undefined, 'a NIL usage must not record a zero');
        assert.equal(result.storage!.limit, 500 * 1024, 'the limit that did parse is still reported');
    });
    it('Commands: status matches item names case-insensitively without reaching the prototype', async () => {
        // The item name is server-controlled and is used as a lookup key. Uppercasing it before the
        // lookup is what keeps a name like "constructor" from resolving to an inherited member, so
        // the matching has to stay case-insensitive AND prototype-safe at the same time.
        const connection: any = createMockConnection({
            state: 2,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.STATUS) {
                    await opts.untagged.STATUS({
                        attributes: [
                            { value: 'INBOX' },
                            [
                                { value: 'constructor' },
                                { value: '1' },
                                { value: '__proto__' },
                                { value: '2' },
                                { value: 'toString' },
                                { value: '3' },
                                { value: 'messages' }, // lowercase: servers send uppercase, but be liberal
                                { value: '10' }
                            ]
                        ]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await statusCommand(connection, 'INBOX', { messages: true });
        assert.equal(result.messages, 10, 'a lowercase item name must still be recognized');
        assert.equal(Object.getPrototypeOf(result), Object.prototype, 'the status object must keep its prototype');
        assert.deepEqual(Object.keys(result).sort(), ['messages', 'path'], 'no prototype-chain name may become a field');
    });
    it('Commands: status does not touch live mailbox state for another mailbox', async () => {
        // The updaters exist to keep the selected mailbox current. Running them for a STATUS of a
        // different mailbox would overwrite exists/uidNext/highestModseq with another folder's counts.
        let emitted: any = [];
        const connection: any = createMockConnection({
            state: 3,
            mailbox: { path: 'INBOX', exists: 5, uidNext: 100, highestModseq: 7n },
            emit: (name: any, payload: any) => emitted.push([name, payload]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.STATUS) {
                    await opts.untagged.STATUS({
                        attributes: [
                            { value: 'Archive' },
                            [{ value: 'MESSAGES' }, { value: '999' }, { value: 'UIDNEXT' }, { value: '888' }, { value: 'HIGHESTMODSEQ' }, { value: '777' }]
                        ]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await statusCommand(connection, 'Archive', { messages: true, uidNext: true, highestModseq: true });
        assert.equal(result.messages, 999, 'the queried mailbox is still reported');
        assert.equal(connection.mailbox.exists, 5, 'the selected mailbox count must be untouched');
        assert.equal(connection.mailbox.uidNext, 100);
        assert.equal(connection.mailbox.highestModseq, 7n);
        assert.equal(emitted.filter((entry: any) => entry[0] === 'exists').length, 0, 'no exists event for another mailbox');
    });
    it('Commands: search drops unusable ESEARCH COUNT, MIN and MAX values', async () => {
        // isNaN() passes '1e400' (Infinity) and '-1'; a COUNT of Infinity or a negative MIN is not a
        // usable answer and must not reach the caller
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['ESEARCH', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.ESEARCH) {
                    await opts.untagged.ESEARCH({
                        attributes: [
                            [{ type: 'ATOM', value: 'TAG' }, { value: 'A1' }],
                            { type: 'ATOM', value: 'COUNT' },
                            { value: '1e400' },
                            { type: 'ATOM', value: 'MIN' },
                            { value: '-1' },
                            { type: 'ATOM', value: 'MAX' },
                            { value: '42' }
                        ]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await searchCommand(connection, { all: true }, { returnOptions: ['COUNT', 'MIN', 'MAX'] });
        assert.equal(result.count, undefined, 'an overflowing COUNT must be dropped');
        assert.equal((result as any).min, undefined, 'a negative MIN must be dropped');
        assert.equal((result as any).max, 42, 'a usable MAX is still reported');
    });
    it('Commands: quota drops unusable resource values', async () => {
        // isNaN() passes '1e5' and ' 12 '; neither is a usable octet count
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['QUOTA', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'GETQUOTAROOT' && opts && opts.untagged && opts.untagged.QUOTA) {
                    await opts.untagged.QUOTA({
                        attributes: [
                            { value: 'root' },
                            [{ value: 'STORAGE' }, { value: '1e5' }, { value: '500' }, { value: 'MESSAGE' }, { value: '10' }, { value: '20' }]
                        ]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await quotaCommand(connection, 'INBOX');
        assert.ok(result, 'the command must actually run');
        assert.equal((result.storage as any).usage, undefined, 'an unusable usage must not be recorded');
        assert.equal(result.message.usage, 10, 'a usable resource is still reported');
        assert.equal(result.message.limit, 20);
    });
    it('Commands: list does not invent a special-use from a prototype-named mailbox', async () => {
        // The special-use hint map is keyed by server-supplied mailbox paths. On a plain object a
        // mailbox literally named "constructor" resolves to Object.prototype.constructor - truthy -
        // and the client would attach a special-use flag the server never sent.
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    for (let path of ['constructor', 'toString', '__proto__']) {
                        await opts.untagged.LIST({
                            attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: path }]
                        });
                    }
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*', {});
        for (let path of ['constructor', 'toString', '__proto__']) {
            const entry = result.find(item => item.path === path);
            assert.ok(entry, `${path} must still be listed`);
            assert.equal(entry.specialUse, undefined, `${path} must not gain a special-use flag`);
        }
    });
});
