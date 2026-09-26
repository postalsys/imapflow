/* eslint-disable new-cap */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import listCommand from '../../src/commands/list.js';
import { createMockConnection } from '../fixtures/mock-connection.js';

// BigInt() is a standard JS function but triggers new-cap rule

// Builds the error shape the reader loop attaches to failed commands: tagged
// rejections carry responseStatus ('BAD'/'NO'), transport and throttling
// failures carry a code ('NoConnection', 'ETHROTTLE').
const commandError = (message: any, responseStatus: any, code: any) => {
    let err: any = new Error(message);
    if (responseStatus) {
        err.responseStatus = responseStatus;
    }
    if (code) {
        (err as any).code = code;
    }
    return err;
};

describe('commands/list', () => {
    it('Commands: list basic', async () => {
        let execCalled = false;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
                execCalled = true;
                // Simulate LIST response
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*');
        assert.equal(execCalled, true);
        assert.ok(Array.isArray(result));
    });
    it('Commands: list with XLIST capability', async () => {
        let usedListCommand = '';
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['XLIST', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                // Capture the first LIST/XLIST command, not LSUB
                if ((cmd === 'LIST' || cmd === 'XLIST') && !usedListCommand) {
                    usedListCommand = cmd;
                }
                if (opts && opts.untagged && opts.untagged[cmd]) {
                    await opts.untagged[cmd]({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                    });
                }
                return { next: () => {} };
            }
        });

        await listCommand(connection, '', '*');
        assert.equal(usedListCommand, 'XLIST');
    });
    it('Commands: list prefers LIST over XLIST when SPECIAL-USE available', async () => {
        let usedListCommand = '';
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([
                ['XLIST', true],
                ['SPECIAL-USE', true]
            ]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                // Capture the first LIST/XLIST command, not LSUB
                if ((cmd === 'LIST' || cmd === 'XLIST') && !usedListCommand) {
                    usedListCommand = cmd;
                }
                if (opts && opts.untagged && opts.untagged[cmd]) {
                    await opts.untagged[cmd]({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                    });
                }
                return { next: () => {} };
            }
        });

        await listCommand(connection, '', '*');
        assert.equal(usedListCommand, 'LIST');
    });
    it('Commands: list with statusQuery', async () => {
        let listAttrs = null;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([
                ['LIST-STATUS', true],
                ['SPECIAL-USE', true]
            ]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST') {
                    listAttrs = attrs;
                    if (opts && opts.untagged && opts.untagged.LIST) {
                        await opts.untagged.LIST({
                            attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                        });
                    }
                    if (opts && opts.untagged && opts.untagged.STATUS) {
                        await opts.untagged.STATUS({
                            attributes: [{ value: 'INBOX' }, [{ value: 'MESSAGES' }, { value: '10' }, { value: 'UNSEEN' }, { value: '5' }]]
                        });
                    }
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*', {
            statusQuery: { messages: true, unseen: true }
        });
        assert.ok(listAttrs);
        const attrsStr = JSON.stringify(listAttrs);
        assert.ok(attrsStr.includes('RETURN'));
        assert.ok(attrsStr.includes('STATUS'));
        assert.ok(Array.isArray(result));
    });
    it('Commands: list statusQuery parses inline SIZE and DELETED on rev2 sessions', async () => {
        let listAttrs = null;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IMAP4rev2', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST') {
                    listAttrs = attrs;
                    if (opts && opts.untagged && opts.untagged.LIST) {
                        await opts.untagged.LIST({
                            attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                        });
                    }
                    if (opts && opts.untagged && opts.untagged.STATUS) {
                        await opts.untagged.STATUS({
                            attributes: [
                                { value: 'INBOX' },
                                [{ value: 'MESSAGES' }, { value: '10' }, { value: 'SIZE' }, { value: '12345678901234' }, { value: 'DELETED' }, { value: '3' }]
                            ]
                        });
                    }
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*', {
            statusQuery: { messages: true, size: true, deleted: true }
        });
        const attrsStr = JSON.stringify(listAttrs);
        assert.ok(attrsStr.includes('SIZE'));
        assert.ok(attrsStr.includes('DELETED'));
        const inbox: any = result.find(entry => entry.path === 'INBOX');
        assert.ok(inbox);
        assert.equal(inbox.status.messages, 10);
        // STATUS SIZE is a number64 - values beyond 2^32 must survive
        assert.strictEqual(inbox.status!.size, 12345678901234);
        assert.strictEqual(inbox.status!.deleted, 3);
    });
    it('Commands: list tolerates an OLDNAME extended data item', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IMAP4rev2', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    // RFC 9051 6.3.9.7: a LIST response may carry an OLDNAME extended
                    // data item after a RENAME or name normalization - the client must
                    // parse the response without choking on the extra attribute
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'NewBox' }, [{ value: 'OLDNAME' }, [{ value: 'OldBox' }]]]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*');
        const entry = result.find(folder => folder.path === 'NewBox');
        assert.ok(entry, 'mailbox with OLDNAME extended data must be listed');
        assert.ok(entry.flags.has('\\HasNoChildren'));
    });
    it('Commands: list with CONDSTORE status query', async () => {
        let listAttrs = null;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([
                ['LIST-STATUS', true],
                ['CONDSTORE', true]
            ]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST') {
                    listAttrs = attrs;
                    if (opts && opts.untagged && opts.untagged.LIST) {
                        await opts.untagged.LIST({
                            attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                        });
                    }
                }
                return { next: () => {} };
            }
        });

        await listCommand(connection, '', '*', {
            statusQuery: { highestModseq: true }
        });
        assert.ok(listAttrs);
        const attrsStr = JSON.stringify(listAttrs);
        assert.ok(attrsStr.includes('HIGHESTMODSEQ'));
    });
    it('Commands: list with listOnly option', async () => {
        let lsubCalled = false;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LSUB') {
                    lsubCalled = true;
                }
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*', { listOnly: true });
        assert.equal(lsubCalled, false);
        assert.ok(Array.isArray(result));
    });
    it('Commands: list with specialUseHints', async () => {
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Sent Items' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*', {
            specialUseHints: { sent: 'Sent Items' }
        });
        assert.ok(Array.isArray(result));
        // The Sent Items folder should have specialUse set
        const sentFolder = result.find(e => e.path === 'Sent Items');
        assert.ok(sentFolder);
        assert.equal(sentFolder.specialUse, '\\Sent');
    });
    it('Commands: list handles INBOX specially', async () => {
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if ((cmd === 'LIST' || cmd === 'LSUB') && opts && opts.untagged) {
                    const handler = opts.untagged[cmd];
                    if (handler) {
                        await handler({
                            attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                        });
                    }
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*');
        const inbox = result.find(e => e.path === 'INBOX');
        assert.ok(inbox);
        assert.equal(inbox.specialUse, '\\Inbox');
        // INBOX should always be subscribed
        assert.equal(inbox.subscribed, true);
    });
    it('Commands: list runs separate INBOX query when using namespace', async () => {
        let listCalls = 0;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST') {
                    listCalls++;
                    if (opts && opts.untagged && opts.untagged.LIST) {
                        // First call is for the namespace, second for INBOX
                        if (listCalls === 1) {
                            await opts.untagged.LIST({
                                attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX/Subfolder' }]
                            });
                        } else {
                            await opts.untagged.LIST({
                                attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                            });
                        }
                    }
                }
                return { next: () => {} };
            }
        });

        await listCommand(connection, 'INBOX/', '*');
        // Should have called LIST twice - once for namespace, once for INBOX
        assert.equal(listCalls, 2);
    });
    it('Commands: list INBOX fixup propagates non-reducible failures', async () => {
        // Both sides of the fixup's retry guard: a NO on the extended call is an operational
        // failure (not a RETURN options rejection), and a BAD on a call that already ran plain
        // has no options left to reduce - neither may trigger the plain retry
        for (let { capabilities, status } of [
            {
                capabilities: [
                    ['IMAP4rev1', true],
                    ['LIST-EXTENDED', true]
                ],
                status: 'NO'
            },
            { capabilities: [['IMAP4rev1', true]], status: 'BAD' }
        ]) {
            let listCalls = 0;
            let lsubCalls = 0;
            const connection: any = createMockConnection({
                state: 3,
                capabilities: new (Map as any)(capabilities),
                exec: async (cmd: any, attrs: any) => {
                    if (cmd === 'LSUB') {
                        lsubCalls++;
                    }
                    if (cmd === 'LIST') {
                        listCalls++;
                        if (attrs[1] === 'INBOX') {
                            throw (commandError as any)('Command failed', status);
                        }
                    }
                    return { next: () => {} };
                }
            });

            try {
                await listCommand(connection, 'Mail/', '*');
                assert.ok(false, 'Should have thrown');
            } catch (err: any) {
                assert.equal(err.responseStatus, status);
            }
            // Main listing and the failed INBOX call - no plain retry, no LSUB merge
            assert.equal(listCalls, 2);
            assert.equal(lsubCalls, 0);
        }
    });
    it('Commands: list handles LSUB merging', async () => {
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Folder1' }]
                    });
                }
                if (cmd === 'LSUB' && opts && opts.untagged && opts.untagged.LSUB) {
                    await opts.untagged.LSUB({
                        attributes: [[{ value: '\\Subscribed' }], { value: '/' }, { value: 'Folder1' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*');
        const folder = result.find(e => e.path === 'Folder1');
        assert.ok(folder);
        assert.equal(folder.subscribed, true);
        assert.equal(folder.listed, true);
    });
    it('Commands: list handles error', async () => {
        const connection: any = createMockConnection({
            state: 3,
            exec: async () => {
                throw new Error('List failed');
            }
        });

        try {
            await listCommand(connection, '', '*');
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.equal(err.message, 'List failed');
        }
    });
    it('Commands: list handles empty attributes', async () => {
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    // Empty attributes - should be skipped
                    await opts.untagged.LIST({ attributes: [] });
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*');
        assert.ok(Array.isArray(result));
        assert.equal(result.length, 0);
    });
    it('Commands: list status fallback when LIST-STATUS not supported', async () => {
        let statusCalls = 0;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map(), // No LIST-STATUS
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            run: async (cmd: any, path: any, query: any) => {
                if (cmd === 'STATUS') {
                    statusCalls++;
                    return { messages: 10, unseen: 5, path };
                }
            },
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*', {
            statusQuery: { messages: true, unseen: true }
        });
        assert.ok(Array.isArray(result));
        // STATUS should have been called for each folder
        assert.equal(statusCalls, 1);
    });
    it('Commands: list handles STATUS errors gracefully', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map(),
            run: async (cmd: any) => {
                if (cmd === 'STATUS') {
                    throw new Error('Status failed');
                }
            },
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*', {
            statusQuery: { messages: true }
        });
        const inbox: any = result.find(e => e.path === 'INBOX');
        assert.ok(inbox);
        // Status should have error property
        assert.ok(inbox.status);
        assert.ok(inbox.status.error);
    });
    it('Commands: list sorts by special use', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['SPECIAL-USE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    // Add folders out of order
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\Trash' }], { value: '/' }, { value: 'Trash' }]
                    });
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                    });
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\Sent' }], { value: '/' }, { value: 'Sent' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*');
        // INBOX should be first (has \\Inbox special use)
        assert.equal(result[0].specialUse, '\\Inbox');
    });
    it('Commands: list handles delimiter in path', async () => {
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [
                            [{ value: '\\HasNoChildren' }],
                            { value: '/' },
                            { value: '/Leading/Slash' } // Path starts with delimiter
                        ]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*');
        const folder = result.find(e => e.name === 'Slash');
        assert.ok(folder);
        // Leading delimiter should be removed
        assert.equal(folder.path, 'Leading/Slash');
    });
    it('Commands: list skips Noselect folders for status', async () => {
        let statusCalls = 0;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map(),
            run: async (cmd: any) => {
                if (cmd === 'STATUS') {
                    statusCalls++;
                    return { messages: 10 };
                }
            },
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\Noselect' }], { value: '/' }, { value: 'Parent' }]
                    });
                }
                return { next: () => {} };
            }
        });

        await listCommand(connection, '', '*', { statusQuery: { messages: true } });
        // STATUS should not be called for Noselect folders
        assert.equal(statusCalls, 0);
    });
    it('Commands: list adds Noselect to NonExistent mailboxes', async () => {
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                    });
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\NonExistent' }], { value: '/' }, { value: 'Phantom' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*');
        const phantom = result.find(e => e.path === 'Phantom');
        assert.ok(phantom);
        // RFC 5258: \\NonExistent implies \\Noselect
        assert.equal(phantom.flags.has('\\Noselect'), true);
        // The original flag is preserved, not replaced
        assert.equal(phantom.flags.has('\\NonExistent'), true);
        const inbox = result.find(e => e.path === 'INBOX');
        assert.ok(inbox);
        assert.equal(inbox.flags.has('\\Noselect'), false);
    });
    it('Commands: list LSUB merge adds Noselect to NonExistent', async () => {
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Folder1' }]
                    });
                }
                if (cmd === 'LSUB' && opts && opts.untagged && opts.untagged.LSUB) {
                    // Some servers only report \\NonExistent in LSUB responses
                    await opts.untagged.LSUB({
                        attributes: [[{ value: '\\NonExistent' }], { value: '/' }, { value: 'Folder1' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*');
        const folder = result.find(e => e.path === 'Folder1');
        assert.ok(folder);
        assert.equal(folder.subscribed, true);
        assert.equal(folder.flags.has('\\NonExistent'), true);
        // RFC 5258: \\NonExistent merged from LSUB implies \\Noselect
        assert.equal(folder.flags.has('\\Noselect'), true);
    });
    it('Commands: list uses RETURN (SUBSCRIBED) instead of LSUB on IMAP4rev2', async () => {
        let lsubCalled = false;
        let listAttrs = false;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IMAP4rev2', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LSUB') {
                    lsubCalled = true;
                }
                if (cmd === 'LIST') {
                    listAttrs = attrs;
                    if (opts && opts.untagged && opts.untagged.LIST) {
                        await opts.untagged.LIST({
                            attributes: [[{ value: '\\Subscribed' }, { value: '\\HasNoChildren' }], { value: '/' }, { value: 'Folder1' }]
                        });
                        await opts.untagged.LIST({
                            attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Folder2' }]
                        });
                    }
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*');
        // IMAP4rev2 removed LSUB, subscription state comes from RETURN (SUBSCRIBED)
        assert.equal(lsubCalled, false);
        assert.ok(JSON.stringify(listAttrs).includes('SUBSCRIBED'));
        const folder1 = result.find(e => e.path === 'Folder1');
        assert.ok(folder1);
        assert.equal(folder1.subscribed, true);
        // The \Subscribed attribute is folded into the subscribed property
        assert.equal(folder1.flags.has('\\Subscribed'), false);
        const folder2 = result.find(e => e.path === 'Folder2');
        assert.ok(folder2);
        assert.ok(!folder2.subscribed);
    });
    it('Commands: list uses RETURN (SUBSCRIBED) with LIST-EXTENDED', async () => {
        let lsubCalled = false;
        let listAttrs = false;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([
                ['IMAP4rev1', true],
                ['LIST-EXTENDED', true]
            ]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LSUB') {
                    lsubCalled = true;
                }
                if (cmd === 'LIST') {
                    listAttrs = attrs;
                    if (opts && opts.untagged && opts.untagged.LIST) {
                        await opts.untagged.LIST({
                            attributes: [[{ value: '\\Subscribed' }, { value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                        });
                    }
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*');
        assert.equal(lsubCalled, false);
        assert.ok(JSON.stringify(listAttrs).includes('SUBSCRIBED'));
        const inbox = result.find(e => e.path === 'INBOX');
        assert.ok(inbox);
        assert.equal(inbox.subscribed, true);
    });
    it('Commands: list keeps RETURN (SUBSCRIBED) on a rev1 session that still advertises IMAP4rev2', async () => {
        // Advertised next to IMAP4rev1 and never enabled - the session is rev1, but the
        // advertisement still says the server understands the extended LIST syntax, and
        // the retry ladder covers a server that does not
        let lsubCalled = false;
        let listAttrs: any = false;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([
                ['IMAP4rev1', true],
                ['IMAP4rev2', true]
            ]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LSUB') {
                    lsubCalled = true;
                }
                if (cmd === 'LIST') {
                    listAttrs = attrs;
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\Subscribed' }, { value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*');
        assert.ok(JSON.stringify(listAttrs).includes('SUBSCRIBED'));
        assert.equal(lsubCalled, false);
        assert.equal(result.find(e => e.path === 'INBOX')!.subscribed, true);
    });
    it('Commands: list sends a plain LIST once the IMAP4rev2 advertisement is disowned', async () => {
        // skipRev2 is set when the server rejected ENABLE IMAP4REV2 (or the caller opted
        // out): the advertisement no longer stands in for LIST-EXTENDED, so no RETURN
        // options are tried and subscription state comes from LSUB
        let lsubCalled = false;
        let listCalls: any[] = [];
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([
                ['IMAP4rev1', true],
                ['IMAP4rev2', true],
                ['CHILDREN', true]
            ]),
            skipRev2: true,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LSUB') {
                    lsubCalled = true;
                    await opts.untagged.LSUB({ attributes: [[], { value: '/' }, { value: 'INBOX' }] });
                }
                if (cmd === 'LIST') {
                    listCalls.push(attrs);
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*');
        assert.equal(listCalls.length, 1);
        assert.equal(listCalls[0].length, 2, 'no RETURN options');
        assert.equal(lsubCalled, true);
        assert.equal(result.find(e => e.path === 'INBOX')!.subscribed, true);
    });
    it('Commands: list listOnly does not add RETURN args on IMAP4rev2', async () => {
        let listAttrs: any = false;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IMAP4rev2', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST') {
                    listAttrs = attrs;
                    if (opts && opts.untagged && opts.untagged.LIST) {
                        await opts.untagged.LIST({
                            attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                        });
                    }
                }
                return { next: () => {} };
            }
        });

        await listCommand(connection, '', '*', { listOnly: true });
        // Just reference and pattern, no RETURN block
        assert.equal(listAttrs.length, 2);
    });
    it('Commands: list survives LSUB rejection', async () => {
        let lsubCalls = 0;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LSUB') {
                    lsubCalls++;
                    // e.g. Exchange responds "BAD Command Argument Error"
                    throw (commandError as any)('Command failed', 'BAD');
                }
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                    });
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Folder1' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await listCommand(connection, '', '*');
        assert.equal(result.length, 2);
        const inbox = result.find((e: any) => e.path === 'INBOX');
        assert.ok(inbox);
        // INBOX is always reported as subscribed even without LSUB data
        assert.equal(inbox.subscribed, true);
        // Nothing reported subscription state, so it is unknown rather than false - every
        // folder is reported as subscribed instead of none of them
        assert.equal(result.find((e: any) => e.path === 'Folder1').subscribed, true);

        // The rejection is remembered - a follow-up listing skips LSUB entirely
        assert.equal(connection.skipLsub, true);
        await listCommand(connection as any, '', '*');
        assert.equal(lsubCalls, 1);
    });
    it('Commands: list keeps a genuinely empty subscription set', async () => {
        // LSUB answers, it just has nothing to report. That is a real "nothing is
        // subscribed", not the unknown state, so it must not be overwritten
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Folder1' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await listCommand(connection, '', '*');
        assert.ok(!result.find((entry: any) => entry.path === 'Folder1').subscribed);
    });
    it('Commands: list treats an ignored RETURN (SUBSCRIBED) plus a rejected LSUB as unknown', async () => {
        // The server accepts the RETURN option but reports no \Subscribed at all, which is
        // why the listing falls back to LSUB - and that is rejected too. Accepting the
        // command is not the same as answering it, so this is the unknown state
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([
                ['IMAP4rev1', true],
                ['LIST-EXTENDED', true]
            ]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LSUB') {
                    throw (commandError as any)('Command failed', 'BAD');
                }
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Folder1' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await listCommand(connection, '', '*');
        assert.equal(result.find((entry: any) => entry.path === 'Folder1').subscribed, true);
    });
    it('Commands: list leaves phantom folders out of the assumed subscription', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IMAP4rev2', true]]),
            enabled: new Set(['IMAP4REV2']),
            skipListSubscribedArg: true,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Folder1' }]
                    });
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\NonExistent' }], { value: '/' }, { value: 'Ghost' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await listCommand(connection, '', '*');
        assert.equal(result.find((entry: any) => entry.path === 'Folder1').subscribed, true);
        // A folder the server says does not exist is not claimed to be subscribed
        assert.ok(!result.find((entry: any) => entry.path === 'Ghost').subscribed);
    });
    it('Commands: list keeps subscription flags volunteered by a plain LIST', async () => {
        // No RETURN option was granted and LSUB is not available on rev2, but the server
        // reported \Subscribed on its own - that is real state and must not be widened
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IMAP4rev2', true]]),
            enabled: new Set(['IMAP4REV2']),
            skipListSubscribedArg: true,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\Subscribed' }, { value: '\\HasNoChildren' }], { value: '/' }, { value: 'Folder1' }]
                    });
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Folder2' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await listCommand(connection, '', '*');
        assert.equal(result.find((entry: any) => entry.path === 'Folder1').subscribed, true);
        assert.ok(!result.find((entry: any) => entry.path === 'Folder2').subscribed);
    });
    it('Commands: list fails when LSUB dies without a server rejection', async () => {
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LSUB') {
                    // Transport failure, no tagged BAD/NO from the server
                    throw commandError('Connection not available', null, 'NoConnection');
                }
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                    });
                }
                return { next: () => {} };
            }
        });

        try {
            await listCommand(connection, '', '*');
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.equal(err.code, 'NoConnection');
        }
        // A transport failure says nothing about LSUB support - must not latch
        assert.ok(!connection.skipLsub);
    });
    it('Commands: list rewrites a parsed error response into text', async () => {
        const connection: any = createMockConnection({
            state: 3,
            exec: async () => {
                // Same shape as the reader loop attaches for a tagged BAD
                let err: any = (commandError as any)('Command failed', 'BAD');
                err.response = { tag: '5', command: 'BAD', attributes: [{ type: 'TEXT', value: 'Command Argument Error. 12' }] };
                throw err;
            }
        });

        try {
            await listCommand(connection, '', '*');
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            // enhanceCommandError folds the parsed object into a plain string
            assert.equal(typeof err.response, 'string');
            assert.ok(err.response.includes('Command Argument Error') as any);
        }
    });
    it('Commands: list retries with plain LIST when RETURN is rejected', async () => {
        let listCalls = 0;
        let lsubCalled = false;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([
                ['IMAP4rev1', true],
                ['LIST-EXTENDED', true]
            ]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LSUB' && opts && opts.untagged && opts.untagged.LSUB) {
                    lsubCalled = true;
                    await opts.untagged.LSUB({
                        attributes: [[], { value: '/' }, { value: 'Folder1' }]
                    });
                }
                if (cmd === 'LIST') {
                    listCalls++;
                    if (JSON.stringify(attrs).includes('SUBSCRIBED')) {
                        // Partial untagged response arrives before the tagged BAD
                        if (opts && opts.untagged && opts.untagged.LIST) {
                            await opts.untagged.LIST({
                                attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Folder1' }]
                            });
                        }
                        throw (commandError as any)('Command failed', 'BAD');
                    }
                    // Retry must be a plain LIST without RETURN args
                    assert.equal(attrs.length, 2);
                    if (opts && opts.untagged && opts.untagged.LIST) {
                        await opts.untagged.LIST({
                            attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Folder1' }]
                        });
                    }
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*');
        // Extended attempt, auxiliary-free attempt, plain attempt
        assert.equal(listCalls, 3);
        assert.equal(lsubCalled, true);
        // Partial rejected-attempt results were discarded - no duplicate entries
        assert.equal(result.filter(e => e.path === 'Folder1').length, 1);
        const folder: any = result.find(e => e.path === 'Folder1');
        assert.equal(folder.subscribed, true);

        // The plain retry succeeding right after the rejection proves SUBSCRIBED was
        // the offending option - a follow-up listing goes straight to plain LIST
        assert.equal(connection.skipListSubscribedArg, true);
        assert.ok(!connection.skipListStatusArgs);
        await listCommand(connection as any, '', '*');
        assert.equal(listCalls, 4);
    });
    it('Commands: list never falls back to LSUB on a rev2 session', async () => {
        let lsubCalled = false;
        // An Exchange-alike that advertises both revisions and negotiates rev2 via ENABLE,
        // having already proved it rejects RETURN (SUBSCRIBED). The listing therefore
        // carries no subscription state - and the LSUB that rev1 would fall back to is not
        // part of rev2, so asking anyway only risks upsetting the session.
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([
                ['IMAP4rev2', true],
                ['IMAP4rev1', true]
            ]),
            enabled: new Set(['IMAP4REV2']),
            skipListSubscribedArg: true,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LSUB') {
                    lsubCalled = true;
                }
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Folder1' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await listCommand(connection, '', '*');
        assert.equal(lsubCalled, false);
        // Neither source could answer, so the folder is reported as subscribed rather than
        // claiming the server said it is not
        assert.equal(result.find((entry: any) => entry.path === 'Folder1').subscribed, true);
    });
    it('Commands: list does not retry extended LIST on transport errors', async () => {
        let listCalls = 0;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IMAP4rev2', true]]),
            exec: async (cmd: any) => {
                if (cmd === 'LIST') {
                    listCalls++;
                    // Dropped connection - no tagged BAD/NO from the server
                    throw commandError('Connection not available', null, 'NoConnection');
                }
                return { next: () => {} };
            }
        });

        try {
            await listCommand(connection, '', '*');
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.equal(err.code, 'NoConnection');
        }
        // A doomed retry against a dead connection is pointless
        assert.equal(listCalls, 1);
        assert.ok(!connection.skipListSubscribedArg);
    });
    it('Commands: list does not retry extended LIST on NO responses', async () => {
        let listCalls = 0;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IMAP4rev2', true]]),
            exec: async (cmd: any) => {
                if (cmd === 'LIST') {
                    listCalls++;
                    // RFC 9051: unrecognized RETURN options are rejected with BAD;
                    // NO is a transient operational failure
                    throw (commandError as any)('Command failed', 'NO');
                }
                return { next: () => {} };
            }
        });

        try {
            await listCommand(connection, '', '*');
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.equal(err.responseStatus, 'NO');
        }
        assert.equal(listCalls, 1);
        assert.ok(!connection.skipListSubscribedArg);
    });
    it('Commands: list does not treat throttling as a RETURN rejection', async () => {
        let listCalls = 0;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IMAP4rev2', true]]),
            exec: async (cmd: any) => {
                if (cmd === 'LIST') {
                    listCalls++;
                    // O365-style throttling surfaces as BAD plus code ETHROTTLE
                    throw commandError('Request is throttled', 'BAD', 'ETHROTTLE');
                }
                return { next: () => {} };
            }
        });

        try {
            await listCommand(connection, '', '*');
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.equal(err.code, 'ETHROTTLE');
        }
        // Re-issuing against a throttled server and permanently downgrading the
        // connection would both be wrong
        assert.equal(listCalls, 1);
        assert.ok(!connection.skipListSubscribedArg);
    });
    it('Commands: list drops RETURN option groups one stage at a time', async () => {
        let listAttempts: any = [];
        let lsubCalled = false;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([
                ['IMAP4rev1', true],
                ['LIST-EXTENDED', true],
                ['LIST-STATUS', true]
            ]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LSUB') {
                    lsubCalled = true;
                }
                if (cmd === 'LIST') {
                    let flat = JSON.stringify(attrs);
                    listAttempts.push(flat);
                    if (flat.includes('STATUS')) {
                        throw (commandError as any)('Command failed', 'BAD');
                    }
                    if (opts && opts.untagged && opts.untagged.LIST) {
                        await opts.untagged.LIST({
                            attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Folder1' }]
                        });
                    }
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*', { statusQuery: { messages: true } });
        assert.equal(listAttempts.length, 4);
        // Stage 1: both option groups with the auxiliary options
        assert.ok(listAttempts[0].includes('STATUS'));
        assert.ok(listAttempts[0].includes('SUBSCRIBED'));
        assert.ok(listAttempts[0].includes('CHILDREN'));
        // Stage 2: the same groups without the auxiliary options - the rejection
        // might have been about the auxiliaries alone
        assert.ok(listAttempts[1].includes('STATUS'));
        assert.ok(listAttempts[1].includes('SUBSCRIBED'));
        assert.ok(!listAttempts[1].includes('CHILDREN'));
        // Stage 3: SUBSCRIBED dropped, STATUS kept
        assert.ok(listAttempts[2].includes('STATUS'));
        assert.ok(!listAttempts[2].includes('SUBSCRIBED'));
        // Stage 4: plain
        assert.ok(!listAttempts[3].includes('RETURN'));

        // Only the group whose removal was followed by success is latched - the BAD of
        // the earlier stages might have been caused by the STATUS group alone, so
        // SUBSCRIBED stays unproven and gets retried on the next listing
        assert.equal(connection.skipListStatusArgs, true);
        assert.ok(!connection.skipListSubscribedArg);
        assert.ok(!connection.skipListAuxArgs);
        assert.equal(lsubCalled, true);
        assert.equal(result.length, 1);

        // Next listing converges: SUBSCRIBED-only first, no STATUS args
        const result2 = await listCommand(connection as any, '', '*', { statusQuery: { messages: true } });
        assert.equal(listAttempts.length, 5);
        assert.ok(listAttempts[4].includes('SUBSCRIBED'));
        assert.ok(!listAttempts[4].includes('STATUS'));
        assert.equal(result2.length, 1);
    });
    it('Commands: list does not latch flags when the reduced retry also dies', async () => {
        let listCalls = 0;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([
                ['IMAP4rev1', true],
                ['LIST-EXTENDED', true],
                ['LIST-STATUS', true]
            ]),
            exec: async (cmd: any) => {
                if (cmd === 'LIST') {
                    listCalls++;
                    if (listCalls === 1) {
                        throw (commandError as any)('Command failed', 'BAD');
                    }
                    // The reduced retry dies on a transport error
                    throw commandError('Connection not available', null, 'NoConnection');
                }
                return { next: () => {} };
            }
        });

        try {
            await listCommand(connection, '', '*', { statusQuery: { messages: true } });
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.equal(err.code, 'NoConnection');
        }
        // Nothing was proven - no flag may be latched
        assert.equal(listCalls, 2);
        assert.ok(!connection.skipListSubscribedArg);
        assert.ok(!connection.skipListStatusArgs);
        assert.ok(!connection.skipListAuxArgs);
    });
    it('Commands: list tolerates LSUB NO without latching', async () => {
        let lsubCalls = 0;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LSUB') {
                    lsubCalls++;
                    // Transient operational failure, not a missing command
                    throw (commandError as any)('Server busy', 'NO');
                }
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*');
        assert.equal(result.length, 1);
        // NO is transient - the next listing must try LSUB again
        assert.ok(!connection.skipLsub);
        await listCommand(connection as any, '', '*');
        assert.equal(lsubCalls, 2);
    });
    it('Commands: list rethrows throttled LSUB without latching', async () => {
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LSUB') {
                    throw commandError('Request is throttled', 'BAD', 'ETHROTTLE');
                }
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                    });
                }
                return { next: () => {} };
            }
        });

        try {
            await listCommand(connection, '', '*');
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.equal(err.code, 'ETHROTTLE');
        }
        // Throttling says nothing about LSUB support
        assert.ok(!connection.skipLsub);
    });
    it('Commands: list folds LSUB-delivered Subscribed flag into the property', async () => {
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Folder1' }]
                    });
                }
                if (cmd === 'LSUB' && opts && opts.untagged && opts.untagged.LSUB) {
                    // Some servers echo the RFC 5258 \Subscribed attribute in LSUB
                    await opts.untagged.LSUB({
                        attributes: [[{ value: '\\Subscribed' }], { value: '/' }, { value: 'Folder1' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*');
        const folder: any = result.find(e => e.path === 'Folder1');
        assert.equal(folder.subscribed, true);
        // The flag is folded into the property on the LSUB merge path too
        assert.equal(folder!.flags.has('\\Subscribed'), false);
    });
    it('Commands: list retries INBOX fixup plain without latching', async () => {
        let listAttempts: any = [];
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([
                ['IMAP4rev1', true],
                ['LIST-EXTENDED', true]
            ]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST') {
                    let flat = JSON.stringify(attrs);
                    listAttempts.push(flat);
                    if (listAttempts.length === 2) {
                        // Fixup call with RETURN args is rejected by a quirky server
                        throw (commandError as any)('Command failed', 'BAD');
                    }
                    if (opts && opts.untagged && opts.untagged.LIST) {
                        if (listAttempts.length === 1) {
                            await opts.untagged.LIST({
                                attributes: [[{ value: '\\Subscribed' }, { value: '\\HasNoChildren' }], { value: '.' }, { value: 'Prefix.Folder1' }]
                            });
                        } else {
                            await opts.untagged.LIST({
                                attributes: [[{ value: '\\HasNoChildren' }], { value: '.' }, { value: 'INBOX' }]
                            });
                        }
                    }
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, 'Prefix.', '*');
        // Main listing + rejected fixup + plain fixup retry
        assert.equal(listAttempts.length, 3);
        assert.ok(listAttempts[1].includes('SUBSCRIBED'));
        assert.ok(!listAttempts[2].includes('RETURN'));
        // Entries from the successful main run were kept
        assert.ok(result.find(e => e.path === 'Prefix.Folder1'));
        assert.ok(result.find(e => e.path === 'INBOX'));
        // The main run succeeded with the same RETURN args - nothing may be latched
        assert.ok(!connection.skipListSubscribedArg);
        assert.ok(!connection.skipListStatusArgs);
    });
    it('Commands: list discards partial results from a rejected INBOX fixup', async () => {
        let listAttempts = [];
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([
                ['IMAP4rev1', true],
                ['LIST-EXTENDED', true],
                ['SPECIAL-USE', true]
            ]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST') {
                    listAttempts.push(JSON.stringify(attrs));
                    if (listAttempts.length === 1) {
                        await opts.untagged.LIST({
                            attributes: [
                                [{ value: '\\Subscribed' }, { value: '\\HasNoChildren' }, { value: '\\Sent' }],
                                { value: '.' },
                                { value: 'Prefix.Folder1' }
                            ]
                        });
                    } else if (listAttempts.length === 2) {
                        // The fixup attempt streams untagged lines and THEN gets the tagged
                        // BAD - the partial lines must not survive the retry. "Aliased" also
                        // claims \Sent and sorts ahead of the main run's Prefix.Folder1, so
                        // it would steal the special-use slot if it were not rolled back
                        await opts.untagged.LIST({
                            attributes: [[{ value: '\\Sent' }], { value: '.' }, { value: 'Aliased' }]
                        });
                        await opts.untagged.LIST({
                            attributes: [[{ value: '\\HasNoChildren' }], { value: '.' }, { value: 'INBOX' }]
                        });
                        throw (commandError as any)('Command failed', 'BAD');
                    } else {
                        await opts.untagged.LIST({
                            attributes: [[{ value: '\\HasNoChildren' }], { value: '.' }, { value: 'INBOX' }]
                        });
                    }
                }
                return { next: () => {} };
            }
        });

        const result: any = await listCommand(connection, 'Prefix.', '*');
        assert.equal(listAttempts.length, 3);
        // Exactly one INBOX entry - the rejected attempt's partial line was discarded
        assert.equal(result.filter((e: any) => e.path === 'INBOX').length, 1);
        assert.ok(!result.some((e: any) => e.path === 'Aliased'), 'the rejected attempt entry is gone');
        // The main run's special-use match survived the rollback of the rejected attempt
        assert.equal(result.find((e: any) => e.path === 'Prefix.Folder1').specialUse, '\\Sent');
    });
    it('Commands: list latches only the auxiliary options when the server rejects them', async () => {
        let listAttempts: any = [];
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([
                ['IMAP4rev1', true],
                ['LIST-EXTENDED', true],
                ['LIST-STATUS', true],
                ['SPECIAL-USE', true]
            ]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST') {
                    let flat = JSON.stringify(attrs);
                    listAttempts.push(flat);
                    if (flat.includes('SPECIAL-USE') || flat.includes('CHILDREN')) {
                        throw (commandError as any)('Command failed', 'BAD');
                    }
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\Subscribed' }, { value: '\\HasNoChildren' }], { value: '/' }, { value: 'Folder1' }]
                    });
                    if (opts.untagged.STATUS) {
                        await opts.untagged.STATUS({
                            attributes: [{ value: 'Folder1' }, [{ value: 'MESSAGES' }, { value: '3' }]]
                        });
                    }
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*', { statusQuery: { messages: true } });
        // Extended attempt with auxiliaries, then the same groups without them
        assert.equal(listAttempts.length, 2);
        assert.ok(listAttempts[0].includes('SPECIAL-USE'));
        assert.ok(listAttempts[1].includes('STATUS'));
        assert.ok(listAttempts[1].includes('SUBSCRIBED'));
        assert.ok(!listAttempts[1].includes('SPECIAL-USE'));
        assert.ok(!listAttempts[1].includes('CHILDREN'));
        // Only the auxiliaries are latched - both option groups survived intact
        assert.equal(connection.skipListAuxArgs, true);
        assert.ok(!connection.skipListSubscribedArg);
        assert.ok(!connection.skipListStatusArgs);
        let folder: any = result.find(e => e.path === 'Folder1');
        assert.equal(folder.subscribed, true);
        assert.equal(folder!.status!.messages, 3);

        // The next listing goes straight to the auxiliary-free extended form
        await listCommand(connection as any, '', '*', { statusQuery: { messages: true } });
        assert.equal(listAttempts.length, 3);
        assert.ok(listAttempts[2].includes('STATUS'));
        assert.ok(listAttempts[2].includes('SUBSCRIBED'));
        assert.ok(!listAttempts[2].includes('SPECIAL-USE'));
    });
    it('Commands: list falls back to LSUB when RETURN (SUBSCRIBED) is silently ignored', async () => {
        let lsubCalled = false;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([
                ['IMAP4rev1', true],
                ['LIST-EXTENDED', true]
            ]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LSUB' && opts && opts.untagged && opts.untagged.LSUB) {
                    lsubCalled = true;
                    await opts.untagged.LSUB({
                        attributes: [[], { value: '/' }, { value: 'Folder1' }]
                    });
                }
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    // Server accepted RETURN (SUBSCRIBED) but returned no \Subscribed flags
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Folder1' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await listCommand(connection, '', '*');
        assert.equal(lsubCalled, true);
        assert.equal(result.find((e: any) => e.path === 'Folder1').subscribed, true);
    });
    it('Commands: list skips the LSUB safety net on rev2 sessions', async () => {
        let lsubCalled = false;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IMAP4rev2', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LSUB') {
                    lsubCalled = true;
                }
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    // No folder is subscribed - legitimate on a fresh account, and rev2
                    // removed LSUB so there is nothing to fall back to
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Folder1' }]
                    });
                }
                return { next: () => {} };
            }
        });

        await listCommand(connection, '', '*');
        assert.equal(lsubCalled, false);
    });
    it('Commands: list honors special-use flags on rev2-only servers', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IMAP4rev2', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    // RFC 9051 folds the RFC 6154 attributes into base rev2 - no separate
                    // SPECIAL-USE capability token is required
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\Sent' }, { value: '\\HasNoChildren' }], { value: '/' }, { value: 'Custom-Sent-Name' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*');
        const folder: any = result.find(e => e.path === 'Custom-Sent-Name');
        assert.equal(folder.specialUse, '\\Sent');
    });
    it('Commands: list uses inline STATUS on rev2-only servers and omits RECENT', async () => {
        let listAttrs: any = false;
        let statusCommands = 0;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IMAP4rev2', true]]),
            run: async (cmd: any) => {
                if (cmd === 'STATUS') {
                    statusCommands++;
                }
                return {};
            },
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST') {
                    listAttrs = JSON.stringify(attrs);
                    if (opts && opts.untagged && opts.untagged.LIST) {
                        await opts.untagged.LIST({
                            attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                        });
                    }
                    if (opts && opts.untagged && opts.untagged.STATUS) {
                        await opts.untagged.STATUS({
                            attributes: [{ value: 'INBOX' }, [{ value: 'MESSAGES' }, { value: '5' }]]
                        });
                    }
                }
                return { next: () => {} };
            }
        });

        const result: any = await listCommand(connection, '', '*', { statusQuery: { messages: true, recent: true } });
        // LIST-STATUS is part of base rev2, so STATUS data arrives inline
        assert.ok((listAttrs as any).includes('STATUS'));
        // RECENT was removed in rev2 and must not be requested
        assert.ok(!(listAttrs as any).includes('RECENT'));
        assert.equal(statusCommands, 0);
        assert.equal(result.find((e: any) => e.path === 'INBOX').status.messages, 5);
        // The requested recent value is synthesized - rev2 defines it as always 0
        assert.equal(result.find((e: any) => e.path === 'INBOX').status.recent, 0);
    });
    it('Commands: list does not let NonExistent phantoms win special-use by name', async () => {
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    // Phantom subscription leftover of a deleted folder
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\NonExistent' }, { value: '\\Subscribed' }], { value: '/' }, { value: 'Sent' }]
                    });
                    // The real sent-mail folder, matched by name
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Sent Messages' }]
                    });
                }
                if (cmd === 'LSUB') {
                    throw (commandError as any)('Command failed', 'BAD');
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*');
        const phantom = result.find(e => e.path === 'Sent');
        const real: any = result.find(e => e.path === 'Sent Messages');
        assert.ok(phantom);
        assert.notEqual(phantom.specialUse, '\\Sent');
        assert.equal(real.specialUse, '\\Sent');
    });
    it('Commands: list does not STATUS NonExistent mailboxes', async () => {
        let statusPaths: any = [];
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map(),
            run: async (cmd: any, path: any) => {
                if (cmd === 'STATUS') {
                    statusPaths.push(path);
                    return { messages: 10 };
                }
            },
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                    });
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\NonExistent' }], { value: '/' }, { value: 'Phantom' }]
                    });
                }
                return { next: () => {} };
            }
        });

        await listCommand(connection, '', '*', { statusQuery: { messages: true } });
        // STATUS runs for the selectable mailbox only
        assert.deepEqual(statusPaths, ['INBOX']);
    });
    it('Commands: list XLIST removes Inbox flag from non-INBOX', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['XLIST', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'XLIST' && opts && opts.untagged && opts.untagged.XLIST) {
                    // XLIST may have localised inbox name with \\Inbox flag
                    await opts.untagged.XLIST({
                        attributes: [
                            [{ value: '\\Inbox' }, { value: '\\HasNoChildren' }],
                            { value: '/' },
                            { value: 'Posteingang' } // German for inbox
                        ]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*');
        const folder = result.find(e => e.path === 'Posteingang');
        assert.ok(folder);
        // \\Inbox flag should be removed from flags set
        assert.equal(folder.flags.has('\\Inbox'), false);
        // But it should have \\Inbox special use
        assert.equal(folder.specialUse, '\\Inbox');
    });
    it('Commands: list LSUB path with leading delimiter', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['SPECIAL-USE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Folder1' }]
                    });
                }
                if (cmd === 'LSUB' && opts && opts.untagged && opts.untagged.LSUB) {
                    // LSUB returns path with leading delimiter
                    await opts.untagged.LSUB({
                        attributes: [
                            [{ value: '\\Subscribed' }],
                            { value: '/' },
                            { value: '/Folder1' } // Leading delimiter
                        ]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*');
        const folder = result.find(e => e.path === 'Folder1');
        assert.ok(folder);
        assert.equal(folder.subscribed, true);
    });
    it('Commands: list sorts non-special-use after special-use', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['SPECIAL-USE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    // Regular folder first
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'ZFolder' }]
                    });
                    // Then INBOX (special use)
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*');
        // INBOX (special use) should come before ZFolder (no special use)
        const inboxIndex = result.findIndex(e => e.path === 'INBOX');
        const zFolderIndex = result.findIndex(e => e.path === 'ZFolder');
        assert.ok(inboxIndex < zFolderIndex, 'Special use folders should sort before non-special-use');
    });
    it('Commands: list sorts alphabetically when no special use', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['SPECIAL-USE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    // Folders without special use in reverse alphabetical order
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Zebra' }]
                    });
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Alpha' }]
                    });
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Middle' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*');
        // Should be sorted alphabetically
        const alphaIndex = result.findIndex(e => e.path === 'Alpha');
        const middleIndex = result.findIndex(e => e.path === 'Middle');
        const zebraIndex = result.findIndex(e => e.path === 'Zebra');
        assert.ok(alphaIndex < middleIndex, 'Alpha should come before Middle');
        assert.ok(middleIndex < zebraIndex, 'Middle should come before Zebra');
    });
    it('Commands: list sorts nested folders by parent path', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['SPECIAL-USE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    // Nested folders
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasChildren' }], { value: '/' }, { value: 'B' }]
                    });
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'B/Nested' }]
                    });
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasChildren' }], { value: '/' }, { value: 'A' }]
                    });
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'A/Nested' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*');
        // A folders should come before B folders
        const aIndex = result.findIndex(e => e.path === 'A');
        const aNestedIndex = result.findIndex(e => e.path === 'A/Nested');
        const bIndex = result.findIndex(e => e.path === 'B');
        const bNestedIndex = result.findIndex(e => e.path === 'B/Nested');
        assert.ok(aIndex < bIndex, 'A should come before B');
        assert.ok(aNestedIndex < bIndex, 'A/Nested should come before B');
        assert.ok(bIndex < bNestedIndex || aNestedIndex < bNestedIndex, 'Parent folders sort correctly');
    });
    it('Commands: list handles LSUB with empty attributes', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['SPECIAL-USE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'TestFolder' }]
                    });
                }
                if (cmd === 'LSUB' && opts && opts.untagged && opts.untagged.LSUB) {
                    // Empty attributes
                    await opts.untagged.LSUB({
                        attributes: []
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*');
        assert.ok(result.length >= 1);
    });
    it('Commands: list handles STATUS NaN values in LSUB response', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([
                ['SPECIAL-USE', true],
                ['LIST-STATUS', true]
            ]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged) {
                    if (opts.untagged.LIST) {
                        await opts.untagged.LIST({
                            attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'TestFolder' }]
                        });
                    }
                    if (opts.untagged.STATUS) {
                        await opts.untagged.STATUS({
                            attributes: [
                                { value: 'TestFolder' },
                                [
                                    { value: 'MESSAGES' },
                                    { value: 'NaN' }, // Invalid number
                                    { value: 'RECENT' },
                                    { value: 'invalid' } // Invalid value
                                ]
                            ]
                        });
                    }
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*', { statusQuery: { messages: true, recent: true } });
        const folder: any = result.find(e => e.path === 'TestFolder');
        assert.ok(folder);
        // NaN values should be filtered out (value === false check)
        assert.equal(folder.status.messages, undefined);
        assert.equal(folder.status!.recent, undefined);
    });
    it('Commands: list STATUS parses UIDVALIDITY UNSEEN HIGHESTMODSEQ', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([
                ['LIST-STATUS', true],
                ['CONDSTORE', true]
            ]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST') {
                    if (opts && opts.untagged && opts.untagged.LIST) {
                        await opts.untagged.LIST({
                            attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'TestFolder' }]
                        });
                    }
                    if (opts && opts.untagged && opts.untagged.STATUS) {
                        await opts.untagged.STATUS({
                            attributes: [
                                { value: 'TestFolder' },
                                [
                                    { value: 'UIDVALIDITY' },
                                    { value: '123456789' },
                                    { value: 'UNSEEN' },
                                    { value: '42' },
                                    { value: 'HIGHESTMODSEQ' },
                                    { value: '999999999' }
                                ]
                            ]
                        });
                    }
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*', {
            statusQuery: { uidValidity: true, unseen: true, highestModseq: true }
        });
        const folder = result.find(e => e.path === 'TestFolder');
        assert.ok(folder);
        assert.ok(folder.status);
        assert.equal(folder.status.uidValidity, BigInt(123456789));
        assert.equal(folder.status.unseen, 42);
        assert.equal(folder.status.highestModseq, BigInt(999999999));
    });
    it('Commands: list LSUB folder not in LIST entries', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['SPECIAL-USE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    // Only return INBOX in LIST
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                    });
                }
                if (cmd === 'LSUB' && opts && opts.untagged && opts.untagged.LSUB) {
                    // Return a folder in LSUB that wasn't in LIST (hits else branch)
                    await opts.untagged.LSUB({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'SubscribedOnly' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*');
        // The subscribed-only folder should not be in results (else branch ignores it)
        const subscribedOnly = result.find(e => e.path === 'SubscribedOnly');
        assert.equal(subscribedOnly, undefined);
        // INBOX should still be there
        const inbox = result.find(e => e.path === 'INBOX');
        assert.ok(inbox);
    });
    it('Commands: list sort b has specialUse a does not', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['SPECIAL-USE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    // First add a folder without special use
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'AAA_Regular' }]
                    });
                    // Then add INBOX which gets special use
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*');
        // When sorting, INBOX has specialUse, AAA_Regular does not
        // So the comparison should hit: !a.specialUse && b.specialUse returns 1
        // This means INBOX should come first even though AAA_Regular is alphabetically first
        assert.ok(result.length >= 2);
        assert.equal(result[0].path, 'INBOX');
        assert.equal(result[0].specialUse, '\\Inbox');
    });
    it('Commands: list sort fallback path comparison', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['SPECIAL-USE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    // Create folders where parent parts match but paths differ at the end
                    // A/B/C and A/B will have matching parts up to a point
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Parent/Child/Deep' }]
                    });
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Parent/Child' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*');
        // Parent/Child should come before Parent/Child/Deep
        const childIndex = result.findIndex(e => e.path === 'Parent/Child');
        const deepIndex = result.findIndex(e => e.path === 'Parent/Child/Deep');
        assert.ok(childIndex < deepIndex, 'Shorter path should sort before longer when parent matches');
    });
    it('Commands: list STATUS handles unknown key in response', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([
                ['SPECIAL-USE', true],
                ['LIST-STATUS', true]
            ]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged) {
                    if (opts.untagged.LIST) {
                        await opts.untagged.LIST({
                            attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'TestFolder' }]
                        });
                    }
                    if (opts.untagged.STATUS) {
                        await opts.untagged.STATUS({
                            attributes: [{ value: 'TestFolder' }, [{ value: 'XUNKNOWN' }, { value: '999' }, { value: 'MESSAGES' }, { value: '10' }]]
                        });
                    }
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*', { statusQuery: { messages: true } });
        const folder: any = result.find(e => e.path === 'TestFolder');
        assert.ok(folder);
        assert.ok(folder.status);
        assert.equal(folder.status.messages, 10);
        assert.equal(folder.status.XUNKNOWN, undefined); // Unknown keys silently ignored
    });
});
