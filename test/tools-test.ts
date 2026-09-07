import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as tools from '../src/tools.js';
import { parser } from '../src/handler/imap-handler.js';
import crypto from 'node:crypto';
import iconv from 'iconv-lite';
import type { MailboxObject } from '../src/types.js';

// Mock connection for testing
let createMockConnection = (options = {}) => ({
    enabled: new Set((options as any).enabled || ((options as any).utf8 ? ['UTF8=ACCEPT'] : [])),
    capabilities: new Map((options as any).capabilities || []),
    namespace: (options as any).namespace || null
});

describe('tools', () => {
    // ============================================
    // encodePath / decodePath tests
    // ============================================
    it('Tools: encodePath with ASCII path', () => {
        let connection: any = createMockConnection();
        let result = tools.encodePath(connection, 'INBOX');
        assert.equal(result, 'INBOX');
    });
    it('Tools: encodePath with ASCII path (no UTF8)', () => {
        let connection: any = createMockConnection({ utf8: false });
        let result = tools.encodePath(connection, 'Sent/Gesendete');
        // ASCII path should remain unchanged
        assert.equal(result, 'Sent/Gesendete');
    });
    it('Tools: encodePath encodes Unicode to modified UTF-7 on rev1 (no UTF8)', () => {
        let connection: any = createMockConnection({ utf8: false });
        // 'õ' (U+00F5) -> UTF-16BE 00F5 -> modified-base64 'APU'
        assert.equal(tools.encodePath(connection, 'Tõrva'), 'T&APU-rva');
        // a literal '&' must be escaped as '&-'
        assert.equal(tools.encodePath(connection as any, 'Test&Folder'), 'Test&-Folder');
    });
    it('Tools: encodePath with Unicode when UTF8=ACCEPT enabled', () => {
        let connection: any = createMockConnection({ utf8: true });
        let result = tools.encodePath(connection, 'Posteingang/Ordner');
        // With UTF8=ACCEPT, path should remain unchanged
        assert.equal(result, 'Posteingang/Ordner');
    });
    it('Tools: encodePath with null/undefined', () => {
        let connection: any = createMockConnection();
        assert.equal(tools.encodePath(connection, null as any), '');
        assert.equal(tools.encodePath(connection as any, undefined), '');
    });
    it('Tools: decodePath with ASCII path', () => {
        let connection: any = createMockConnection();
        let result = tools.decodePath(connection, 'INBOX');
        assert.equal(result, 'INBOX');
    });
    it('Tools: decodePath with ampersand', () => {
        let connection: any = createMockConnection({ utf8: false });
        // modified UTF-7: '&-' is the escaped form of a literal ampersand
        assert.equal(tools.decodePath(connection, 'Test&-Folder'), 'Test&Folder');
        // and an encoded sequence round-trips back to Unicode
        assert.equal(tools.decodePath(connection as any, 'T&APU-rva'), 'Tõrva');
    });
    it('Tools: decodePath with UTF8=ACCEPT enabled', () => {
        let connection: any = createMockConnection({ utf8: true });
        let result = tools.decodePath(connection, 'Test&Folder');
        // With UTF8=ACCEPT, should not decode
        assert.equal(result, 'Test&Folder');
    });
    it('Tools: decodePath with null/undefined', () => {
        let connection: any = createMockConnection();
        assert.equal(tools.decodePath(connection, null as any), '');
        assert.equal(tools.decodePath(connection as any, undefined), '');
    });

    // ============================================
    // normalizePath tests
    // ============================================
    it('Tools: normalizePath with INBOX (case insensitive)', () => {
        let connection: any = createMockConnection();
        assert.equal(tools.normalizePath(connection, 'inbox'), 'INBOX');
        assert.equal(tools.normalizePath(connection as any, 'INBOX'), 'INBOX');
        assert.equal(tools.normalizePath(connection as any, 'InBox'), 'INBOX');
    });
    it('Tools: normalizePath with array path', () => {
        let connection: any = createMockConnection({
            namespace: { delimiter: '/', prefix: '' }
        });
        let result = tools.normalizePath(connection, ['Folder', 'Subfolder']);
        assert.equal(result, 'Folder/Subfolder');
    });
    it('Tools: normalizePath with namespace prefix', () => {
        let connection: any = createMockConnection({
            namespace: { delimiter: '.', prefix: 'INBOX.' }
        });
        let result = tools.normalizePath(connection, 'Sent');
        assert.equal(result, 'INBOX.Sent');
    });
    it('Tools: normalizePath skip namespace', () => {
        let connection: any = createMockConnection({
            namespace: { delimiter: '.', prefix: 'INBOX.' }
        });
        let result = tools.normalizePath(connection, 'Sent', true);
        assert.equal(result, 'Sent');
    });
    it('Tools: normalizePath already has prefix', () => {
        let connection: any = createMockConnection({
            namespace: { delimiter: '.', prefix: 'INBOX.' }
        });
        let result = tools.normalizePath(connection, 'INBOX.Sent');
        assert.equal(result, 'INBOX.Sent');
    });

    // ============================================
    // comparePaths tests
    // ============================================
    it('Tools: comparePaths equal paths', () => {
        let connection: any = createMockConnection();
        assert.equal(tools.comparePaths(connection, 'INBOX', 'INBOX'), true);
        assert.equal(tools.comparePaths(connection as any, 'inbox', 'INBOX'), true);
    });
    it('Tools: comparePaths different paths', () => {
        let connection: any = createMockConnection();
        assert.equal(tools.comparePaths(connection, 'INBOX', 'Sent'), false);
    });
    it('Tools: comparePaths with null/undefined', () => {
        let connection: any = createMockConnection();
        assert.equal(tools.comparePaths(connection, null as any, 'INBOX'), false);
        assert.equal(tools.comparePaths(connection as any, 'INBOX', null as any), false);
        assert.equal(tools.comparePaths(connection as any, null as any, null as any), false);
    });

    // ============================================
    // updateCapabilities tests
    // ============================================
    it('Tools: updateCapabilities with valid list', () => {
        let list: any = [{ value: 'IMAP4rev1' }, { value: 'IDLE' }, { value: 'NAMESPACE' }];
        let result = tools.updateCapabilities(list);
        assert.ok(result instanceof Map);
        assert.equal(result.get('IMAP4rev1'), true);
        assert.equal(result.get('IDLE'), true);
        assert.equal(result.get('NAMESPACE'), true);
    });
    it('Tools: updateCapabilities normalizes IMAP4rev2 casing', () => {
        let list: any = [{ value: 'IMAP4rev2' }, { value: 'imap4rev1' }];
        let result = tools.updateCapabilities(list);
        // Wire tokens are uppercased, but the rev1/rev2 keys use the RFC spelling
        assert.equal(result.get('IMAP4rev2'), true);
        assert.equal(result.get('IMAP4rev1'), true);
        assert.equal(result.has('IMAP4REV2'), false);
    });
    it('Tools: isRev2Active for rev2-only server', () => {
        // rev2 without rev1 means rev2 is the base protocol, no ENABLE needed
        let connection: any = createMockConnection({ capabilities: [['IMAP4rev2', true]] });
        assert.equal(tools.isRev2Active(connection), true);
    });
    it('Tools: isRev2Active for dual server without ENABLE', () => {
        // Advertising both keeps the session in rev1 mode until ENABLE IMAP4rev2
        let connection: any = createMockConnection({
            capabilities: [
                ['IMAP4rev1', true],
                ['IMAP4rev2', true]
            ]
        });
        assert.equal(tools.isRev2Active(connection), false);
    });
    it('Tools: isRev2Active for dual server with ENABLE', () => {
        let connection: any = createMockConnection({
            capabilities: [
                ['IMAP4rev1', true],
                ['IMAP4rev2', true]
            ],
            enabled: ['IMAP4REV2']
        });
        assert.equal(tools.isRev2Active(connection), true);
    });
    it('Tools: isRev2Active for rev1-only server', () => {
        let connection: any = createMockConnection({ capabilities: [['IMAP4rev1', true]] });
        assert.equal(tools.isRev2Active(connection), false);
    });
    it('Tools: hasCapability with advertised token', () => {
        let connection: any = createMockConnection({
            capabilities: [
                ['IMAP4rev1', true],
                ['UIDPLUS', true]
            ]
        });
        assert.equal(tools.hasCapability(connection, 'UIDPLUS'), true);
        assert.equal(tools.hasCapability(connection as any, 'MOVE'), false);
    });
    it('Tools: hasCapability folds extensions into active rev2', () => {
        let connection: any = createMockConnection({ capabilities: [['IMAP4rev2', true]] });
        // RFC 9051 Appendix E folds these into base IMAP4rev2 - the complete set
        for (let capability of [
            'ENABLE',
            'ESEARCH',
            'IDLE',
            'LIST-EXTENDED',
            'LIST-STATUS',
            'LITERAL-',
            'MOVE',
            'NAMESPACE',
            'SASL-IR',
            'SEARCHRES',
            'SPECIAL-USE',
            'STATUS=SIZE',
            'UIDPLUS',
            'UNSELECT'
        ]) {
            assert.equal(tools.hasCapability(connection, capability), true, `${capability} should be folded into rev2`);
        }
        // BINARY is intentionally not folded
        assert.equal(tools.hasCapability(connection as any, 'BINARY'), false);
    });
    it('Tools: hasCapability does not fold on unenabled dual server', () => {
        let connection: any = createMockConnection({
            capabilities: [
                ['IMAP4rev1', true],
                ['IMAP4rev2', true]
            ]
        });
        // Session is in rev1 mode - only explicitly advertised tokens count
        assert.equal(tools.hasCapability(connection, 'UIDPLUS'), false);
    });
    it('Tools: encodePath keeps UTF-8 when rev2 is active', () => {
        let connection: any = createMockConnection({ capabilities: [['IMAP4rev2', true]] });
        // rev2 mailbox names are native UTF-8, modified UTF-7 must not be applied
        assert.equal(tools.encodePath(connection, 'T\u00f5rva'), 'T\u00f5rva');
    });
    it('Tools: decodePath keeps ampersand sequences when rev2 is active', () => {
        let connection: any = createMockConnection({ capabilities: [['IMAP4rev2', true]] });
        // Under rev2 an "&"-sequence is a literal name, not modified UTF-7
        assert.equal(tools.decodePath(connection, 'A&AOQ-B'), 'A&AOQ-B');
    });
    it('Tools: updateCapabilities with APPENDLIMIT', () => {
        let list: any = [{ value: 'APPENDLIMIT=52428800' }];
        let result = tools.updateCapabilities(list);
        assert.equal(result.get('APPENDLIMIT'), 52428800);
    });
    it('Tools: updateCapabilities with empty/null list', () => {
        assert.ok(tools.updateCapabilities(null) instanceof Map);
        assert.ok(tools.updateCapabilities([]) instanceof Map);
        assert.ok(tools.updateCapabilities(undefined) instanceof Map);
    });
    it('Tools: updateCapabilities skips non-string values', () => {
        let list: any = [{ value: 'IDLE' }, { value: 123 }, { value: null }];
        let result = tools.updateCapabilities(list);
        assert.equal(result.get('IDLE'), true);
        assert.equal(result.size, 1);
    });

    // ============================================
    // getStatusCode tests
    // ============================================
    it('Tools: getStatusCode with valid response', () => {
        let response: any = {
            attributes: [
                {
                    section: [{ value: 'TRYCREATE' }]
                }
            ]
        };
        assert.equal(tools.getStatusCode(response), 'TRYCREATE');
    });
    it('Tools: getStatusCode with null/invalid response', () => {
        assert.equal(tools.getStatusCode(null as any), false);
        assert.equal(tools.getStatusCode({}), false);
        assert.equal(tools.getStatusCode({ attributes: [] }), false);
        assert.equal(tools.getStatusCode({ attributes: [{}] } as any), false);
    });

    // ============================================
    // getErrorText tests
    // ============================================
    it('Tools: getErrorText with null response', async () => {
        let result = await tools.getErrorText(null as any);
        assert.equal(result, false);
    });
    it('Tools: getErrorText with valid response', async () => {
        let response = {
            tag: '*',
            command: 'OK',
            attributes: [{ type: 'TEXT', value: 'Success' }]
        };
        let result = await tools.getErrorText(response);
        assert.ok(typeof result === 'string');
    });
    it('Tools: getErrorText survives a response that cannot be re-encoded', async () => {
        // The parser tolerates stray bytes inside an OK/NO/BAD atom, and those have no
        // valid IMAP string encoding. The error text is diagnostic, so it must still be
        // produced rather than replacing the server's error with an encoding failure.
        let response = await parser(Buffer.from('A1 NO [SERVERBUG\x00X] it failed', 'binary'));
        let result = await tools.getErrorText(response);
        assert.ok(typeof result === 'string', 'error text should still be produced');
        assert.ok(result.includes('it failed'), 'the human-readable part must survive');
    });

    // ============================================
    // getFlagColor tests
    // ============================================
    it('Tools: getFlagColor without Flagged', () => {
        let flags = new Set(['\\Seen']);
        assert.equal(tools.getFlagColor(flags), null);
    });
    it('Tools: getFlagColor with Flagged only (red)', () => {
        let flags = new Set(['\\Flagged']);
        assert.equal(tools.getFlagColor(flags), 'red');
    });
    it('Tools: getFlagColor with color bits', () => {
        // bit0=1, bit1=0, bit2=0 => orange (index 1)
        let flags = new Set(['\\Flagged', '$MailFlagBit0']);
        assert.equal(tools.getFlagColor(flags), 'orange');

        // bit0=0, bit1=1, bit2=0 => yellow (index 2)
        flags = new Set(['\\Flagged', '$MailFlagBit1']);
        assert.equal(tools.getFlagColor(flags), 'yellow');

        // bit0=1, bit1=1, bit2=0 => green (index 3)
        flags = new Set(['\\Flagged', '$MailFlagBit0', '$MailFlagBit1']);
        assert.equal(tools.getFlagColor(flags), 'green');

        // bit0=0, bit1=0, bit2=1 => blue (index 4)
        flags = new Set(['\\Flagged', '$MailFlagBit2']);
        assert.equal(tools.getFlagColor(flags), 'blue');

        // bit0=1, bit1=0, bit2=1 => purple (index 5)
        flags = new Set(['\\Flagged', '$MailFlagBit0', '$MailFlagBit2']);
        assert.equal(tools.getFlagColor(flags), 'purple');

        // bit0=0, bit1=1, bit2=1 => grey (index 6)
        flags = new Set(['\\Flagged', '$MailFlagBit1', '$MailFlagBit2']);
        assert.equal(tools.getFlagColor(flags), 'grey');
    });
    it('Tools: getFlagColor with all bits set (index 7) defaults to red', () => {
        // bit0=1, bit1=2, bit2=4 => color=7, FLAG_COLORS[7] is undefined => defaults to 'red'
        let flags = new Set(['\\Flagged', '$MailFlagBit0', '$MailFlagBit1', '$MailFlagBit2']);
        assert.equal(tools.getFlagColor(flags), 'red');
    });

    // ============================================
    // getColorFlags tests
    // ============================================
    it('Tools: getColorFlags with valid color', () => {
        // 'orange' is index 1, which is truthy
        let result: any = tools.getColorFlags('orange');
        assert.ok(Array.isArray(result.add));
        assert.ok(Array.isArray(result!.remove));
        assert.ok(result!.add.includes('\\Flagged'));
    });
    it('Tools: getColorFlags with red (index 0)', () => {
        // 'red' is index 0 — should add \\Flagged and remove all MailFlagBit flags
        let result: any = tools.getColorFlags('red');
        assert.ok(Array.isArray(result.add));
        assert.ok(Array.isArray(result!.remove));
        assert.ok(result!.add.includes('\\Flagged'));
    });
    it('Tools: getColorFlags with null (remove flag)', () => {
        let result: any = tools.getColorFlags(null);
        assert.ok(result.remove.includes('\\Flagged'));
    });
    it('Tools: getColorFlags with invalid color', () => {
        let result = tools.getColorFlags('invalid-color');
        assert.equal(result, null);
    });
    it('Tools: getColorFlags sets correct bits', () => {
        // orange = index 1 = bit0 set
        let result: any = tools.getColorFlags('orange');
        assert.ok(result.add.includes('$MailFlagBit0'));
        assert.ok(result!.remove.includes('$MailFlagBit1'));
        assert.ok(result!.remove.includes('$MailFlagBit2'));

        // green = index 3 = bit0 + bit1 set
        result = tools.getColorFlags('green');
        assert.ok(result!.add.includes('$MailFlagBit0'));
        assert.ok(result!.add.includes('$MailFlagBit1'));
        assert.ok(result!.remove.includes('$MailFlagBit2'));
    });

    // ============================================
    // isDate tests
    // ============================================
    it('Tools: isDate with Date object', () => {
        assert.equal(tools.isDate(new Date()), true);
        assert.equal(tools.isDate(new Date('2023-01-01')), true);
    });
    it('Tools: isDate with non-Date', () => {
        assert.equal(tools.isDate('2023-01-01'), false);
        assert.equal(tools.isDate(12345), false);
        assert.equal(tools.isDate(null), false);
        assert.equal(tools.isDate({}), false);
    });

    // ============================================
    // formatDate tests
    // ============================================
    it('Tools: formatDate with Date object', () => {
        let date = new Date('2023-06-15T00:00:00.000Z');
        let result = tools.formatDate(date);
        assert.equal(result, '15-Jun-2023');
    });
    it('Tools: formatDate with string', () => {
        let result = tools.formatDate('2023-06-15');
        assert.equal(result, '15-Jun-2023');
    });
    it('Tools: formatDate with invalid date', () => {
        let result = tools.formatDate('invalid');
        assert.equal(result, undefined);
    });

    // ============================================
    // formatDateTime tests
    // ============================================
    it('Tools: formatDateTime with Date object', () => {
        let date = new Date('2023-06-15T14:30:45.000Z');
        let result: any = tools.formatDateTime(date);
        assert.ok(result.includes('Jun-2023'));
        assert.ok(result!.includes('14:30:45'));
        assert.ok(result!.includes('+0000'));
    });
    it('Tools: formatDateTime with null/undefined', () => {
        assert.equal(tools.formatDateTime(null), undefined);
        assert.equal(tools.formatDateTime(undefined), undefined);
    });
    it('Tools: formatDateTime with string', () => {
        let result = tools.formatDateTime('2023-06-15T10:00:00Z');
        assert.ok(typeof result === 'string');
        assert.ok(result.includes('Jun-2023'));
    });
    it('Tools: formatDateTime with invalid date string', () => {
        let result = tools.formatDateTime('invalid-date-string');
        assert.equal(result, undefined);
    });

    // ============================================
    // formatFlag tests
    // ============================================
    it('Tools: formatFlag with standard flags', () => {
        assert.equal(tools.formatFlag('\\Seen'), '\\Seen');
        assert.equal(tools.formatFlag('\\SEEN'), '\\Seen');
        assert.equal(tools.formatFlag('\\answered'), '\\Answered');
        assert.equal(tools.formatFlag('\\flagged'), '\\Flagged');
        assert.equal(tools.formatFlag('\\deleted'), '\\Deleted');
        assert.equal(tools.formatFlag('\\draft'), '\\Draft');
    });
    it('Tools: formatFlag with Recent (cannot set)', () => {
        assert.equal(tools.formatFlag('\\Recent'), false);
        assert.equal(tools.formatFlag('\\recent'), false);
    });
    it('Tools: formatFlag with custom flags', () => {
        assert.equal(tools.formatFlag('$CustomFlag'), '$CustomFlag');
        assert.equal(tools.formatFlag('MyFlag'), 'MyFlag');
    });

    // ============================================
    // canUseFlag tests
    // ============================================
    it('Tools: canUseFlag with no mailbox', () => {
        assert.equal(tools.canUseFlag(null, '\\Seen'), true);
    });
    it('Tools: canUseFlag with wildcard permanent flags', () => {
        let mailbox: any = { permanentFlags: new Set(['\\*']) };
        assert.equal(tools.canUseFlag(mailbox, '\\Seen'), true);
        assert.equal(tools.canUseFlag(mailbox as any, '$CustomFlag'), true);
    });
    it('Tools: canUseFlag with specific permanent flags', () => {
        let mailbox: any = { permanentFlags: new Set(['\\Seen', '\\Flagged']) };
        assert.equal(tools.canUseFlag(mailbox, '\\Seen'), true);
        assert.equal(tools.canUseFlag(mailbox as any, '\\Flagged'), true);
        assert.equal(tools.canUseFlag(mailbox as any, '\\Deleted'), false);
    });
    it('Tools: canUseFlag with no permanent flags', () => {
        let mailbox: any = { permanentFlags: null };
        assert.equal(tools.canUseFlag(mailbox, '\\Seen'), true);
    });

    // ============================================
    // expandRange tests
    // ============================================
    it('Tools: expandRange with single values', () => {
        let result = tools.expandRange('1,2,3');
        assert.deepEqual(result, [1, 2, 3]);
    });
    it('Tools: expandRange with range', () => {
        let result = tools.expandRange('1:5');
        assert.deepEqual(result, [1, 2, 3, 4, 5]);
    });
    it('Tools: expandRange with reverse range', () => {
        let result = tools.expandRange('5:1');
        assert.deepEqual(result, [5, 4, 3, 2, 1]);
    });
    it('Tools: expandRange with mixed', () => {
        let result = tools.expandRange('1,3:5,10');
        assert.deepEqual(result, [1, 3, 4, 5, 10]);
    });
    it('Tools: expandRange with same start/end', () => {
        let result = tools.expandRange('5:5');
        assert.deepEqual(result, [5]);
    });
    it('Tools: expandRange skips entries that are not valid nz-numbers', () => {
        // Server-supplied garbage must not produce bogus ids or endless loops
        assert.deepEqual(tools.expandRange('Infinity:5'), []);
        assert.deepEqual(tools.expandRange('0:3'), []);
        assert.deepEqual(tools.expandRange('abc,4,1:x'), [4]);
        assert.deepEqual(tools.expandRange('*'), []);
        assert.deepEqual(tools.expandRange('4294967296'), []);
    });
    it('Tools: expandRange caps hostile range spans', () => {
        // A hostile range like 1:4294967295 is cut off at the expansion limit
        // instead of exhausting memory
        let result = tools.expandRange('1:4294967295');
        assert.equal(result.length, 0x1000000);
        assert.equal(result[0], 1);
        assert.equal(result[result.length - 1], 0x1000000);

        let reverse = tools.expandRange('4294967295:4278190080');
        assert.equal(reverse.length, 0x1000000);
        assert.equal(reverse[0], 4294967295);
    });

    // ============================================
    // packMessageRange tests
    // ============================================
    it('Tools: packMessageRange with sequential numbers', () => {
        let result = tools.packMessageRange([1, 2, 3, 4, 5]);
        assert.equal(result, '1:5');
    });
    it('Tools: packMessageRange with gaps', () => {
        let result = tools.packMessageRange([1, 2, 3, 7, 8, 9]);
        assert.equal(result, '1:3,7:9');
    });
    it('Tools: packMessageRange with single values', () => {
        let result = tools.packMessageRange([1, 5, 10]);
        assert.equal(result, '1,5,10');
    });
    it('Tools: packMessageRange with unsorted input', () => {
        let result = tools.packMessageRange([5, 1, 3, 2, 4]);
        assert.equal(result, '1:5');
    });
    it('Tools: packMessageRange with empty array', () => {
        assert.equal(tools.packMessageRange([]), '');
    });
    it('Tools: packMessageRange with non-array', () => {
        assert.equal(tools.packMessageRange(5), '5');
        assert.equal(tools.packMessageRange(null), '');
    });

    // ============================================
    // processName tests
    // ============================================
    it('Tools: processName with quoted string', () => {
        assert.equal(tools.processName('"John Doe"'), 'John Doe');
    });
    it('Tools: processName with unquoted string', () => {
        assert.equal(tools.processName('John Doe'), 'John Doe');
    });
    it('Tools: processName with null/undefined', () => {
        assert.equal(tools.processName(null), '');
        assert.equal(tools.processName(undefined), '');
    });
    it('Tools: processName with short quoted', () => {
        // String too short to have quotes removed (less than 3 chars)
        assert.equal(tools.processName('""'), '""');
        assert.equal(tools.processName('"a"'), 'a');
    });

    // ============================================
    // decodeText tests
    // ============================================
    it('Tools: decodeText decodes encoded words and strips quotes', () => {
        assert.equal(tools.decodeText('=?utf-8?Q?T=C3=B5nu?='), 'Tõnu');
        assert.equal(tools.decodeText('"=?utf-8?Q?T=C3=B5nu?="'), 'Tõnu');
        assert.equal(tools.decodeText('Plain Name'), 'Plain Name');
    });
    it('Tools: decodeText tolerates missing values', () => {
        // getStrValue returns false for a NIL envelope field
        assert.equal(tools.decodeText(false as any), '');
        assert.equal(tools.decodeText(null as any), '');
        assert.equal(tools.decodeText(undefined as any), '');
    });

    // ============================================
    // getFolderTree tests
    // ============================================
    it('Tools: getFolderTree with flat folders', () => {
        let folders: any = [
            { name: 'INBOX', path: 'INBOX', flags: new Set(), parent: [] },
            { name: 'Sent', path: 'Sent', flags: new Set(), parent: [] }
        ];
        let tree = tools.getFolderTree(folders);

        assert.ok(tree.root);
        assert.ok(Array.isArray(tree.folders));
        assert.equal(tree.folders.length, 2);
    });
    it('Tools: getFolderTree with nested folders', () => {
        let folders: any = [
            { name: 'INBOX', path: 'INBOX', flags: new Set(['\\HasChildren']), parent: [] },
            { name: 'Work', path: 'INBOX/Work', flags: new Set(), parent: ['INBOX'] }
        ];
        let tree: any = tools.getFolderTree(folders);

        assert.ok(tree.root);
        assert.equal(tree.folders.length, 1);
        assert.equal(tree.folders![0].name, 'INBOX');
        assert.ok(Array.isArray(tree.folders![0].folders));
    });
    it('Tools: getFolderTree with Noselect flag', () => {
        let folders: any = [{ name: 'Archive', path: 'Archive', flags: new Set(['\\Noselect']), parent: [] }];
        let tree: any = tools.getFolderTree(folders);

        assert.equal(tree.folders[0].disabled, true);
    });
    it('Tools: getFolderTree with specialUse', () => {
        let folders: any = [{ name: 'Sent', path: 'Sent', flags: new Set(), parent: [], specialUse: '\\Sent' }];
        let tree: any = tools.getFolderTree(folders);

        assert.equal(tree.folders[0].specialUse, '\\Sent');
    });
    it('Tools: getFolderTree with delimiter', () => {
        let folders: any = [{ name: 'Folder', path: 'Folder', flags: new Set(), parent: [], delimiter: '/' }];
        let tree: any = tools.getFolderTree(folders);

        assert.equal(tree.folders[0].delimiter, '/');
    });
    it('Tools: getFolderTree updates existing entries', () => {
        let folders: any = [
            { name: 'INBOX', path: 'INBOX', flags: new Set(['\\HasChildren']), parent: [], listed: true },
            { name: 'INBOX', path: 'INBOX', flags: new Set(['\\HasChildren']), parent: [], subscribed: true }
        ];
        let tree: any = tools.getFolderTree(folders);

        // Should update the existing entry, not create duplicate
        assert.equal(tree.folders.length, 1);
    });

    // ============================================
    // parseEnvelope tests
    // ============================================
    it('Tools: parseEnvelope with complete envelope', () => {
        let entry: any = [
            { value: 'Mon, 15 Jun 2023 10:00:00 +0000' }, // date
            { value: 'Test Subject' }, // subject
            [[{ value: 'Sender Name' }, null, { value: 'sender' }, { value: 'example.com' }]], // from
            [[{ value: 'Sender Name' }, null, { value: 'sender' }, { value: 'example.com' }]], // sender
            [[{ value: 'Reply Name' }, null, { value: 'reply' }, { value: 'example.com' }]], // reply-to
            [[{ value: 'To Name' }, null, { value: 'to' }, { value: 'example.com' }]], // to
            [[{ value: 'CC Name' }, null, { value: 'cc' }, { value: 'example.com' }]], // cc
            [[{ value: 'BCC Name' }, null, { value: 'bcc' }, { value: 'example.com' }]], // bcc
            { value: '<reply-id@example.com>' }, // in-reply-to
            { value: '<message-id@example.com>' } // message-id
        ];

        let result: any = tools.parseEnvelope(entry);

        assert.ok(result.date instanceof Date);
        assert.equal(result.subject, 'Test Subject');
        assert.equal(result.from[0].address, 'sender@example.com');
        assert.equal(result.to![0].address, 'to@example.com');
        assert.equal(result.messageId, '<message-id@example.com>');
    });
    it('Tools: parseEnvelope with minimal envelope', () => {
        let entry = [
            null, // date
            null, // subject
            [], // from
            [], // sender
            [], // reply-to
            [], // to
            [], // cc
            [], // bcc
            null, // in-reply-to
            null // message-id
        ];

        let result = tools.parseEnvelope(entry);
        assert.ok(typeof result === 'object');
        assert.equal(result.subject, undefined);
    });
    it('Tools: parseEnvelope with invalid date', () => {
        let entry: any = [{ value: 'invalid-date' }, null, null, null, null, null, null, null, null, null];

        let result = tools.parseEnvelope(entry);
        assert.equal(result.date, 'invalid-date');
    });
    it('Tools: parseEnvelope with Buffer value', () => {
        let entry: any = [
            { value: Buffer.from('Mon, 15 Jun 2023 10:00:00 +0000') }, // date as Buffer
            { value: Buffer.from('Buffer Subject') }, // subject as Buffer
            [[{ value: Buffer.from('Sender Name') }, null, { value: Buffer.from('sender') }, { value: Buffer.from('example.com') }]], // from with Buffers
            [], // sender
            [], // reply-to
            [], // to
            [], // cc
            [], // bcc
            null, // in-reply-to
            { value: Buffer.from('<msg-id@example.com>') } // message-id as Buffer
        ];

        let result: any = tools.parseEnvelope(entry);
        assert.equal(result.subject, 'Buffer Subject');
        assert.equal(result.from[0].address, 'sender@example.com');
        assert.equal(result.messageId, '<msg-id@example.com>');
    });
    it('Tools: parseEnvelope with empty address parts', () => {
        // When both local part and domain are null/empty, address should be empty string
        let entry: any = [
            null, // date
            null, // subject
            [[{ value: 'Group Name' }, null, null, null]], // from with no email parts (group syntax)
            [], // sender
            [], // reply-to
            [], // to
            [], // cc
            [], // bcc
            null, // in-reply-to
            null // message-id
        ];

        let result = tools.parseEnvelope(entry);
        // Address '@' should be converted to empty string and filtered out if no name
        assert.ok(result.from);
        // The entry has a name but no valid address, should still be included with empty address
        assert.equal(result.from.length, 1);
        assert.equal(result.from[0].name, 'Group Name');
        assert.equal(result.from[0].address, '');
    });
    it('Tools: parseEnvelope keeps group syntax out of the address', () => {
        // RFC 9051 7.5.2: a NIL host marks group syntax, so "undisclosed-recipients:;" must
        // not turn into the invented address "undisclosed-recipients@"
        let entry: any = [
            null, // date
            null, // subject
            [], // from
            [], // sender
            [], // reply-to
            [
                [null, null, { value: 'undisclosed-recipients' }, null], // start of group
                [null, null, null, null] // end of group
            ], // to
            [], // cc
            [], // bcc
            null, // in-reply-to
            null // message-id
        ];

        let result = tools.parseEnvelope(entry);
        // The end-of-group marker carries neither name nor address and is dropped
        assert.deepEqual(result.to, [{ name: 'undisclosed-recipients', address: '' }]);
    });
    it('Tools: parseEnvelope keeps group members alongside the markers', () => {
        let entry: any = [
            null, // date
            null, // subject
            [], // from
            [], // sender
            [], // reply-to
            [
                [null, null, { value: 'Team' }, null], // start of group
                [{ value: 'Member One' }, null, { value: 'one' }, { value: 'example.com' }],
                [{ value: 'Member Two' }, null, { value: 'two' }, { value: 'example.com' }],
                [null, null, null, null] // end of group
            ], // to
            [], // cc
            [], // bcc
            null, // in-reply-to
            null // message-id
        ];

        let result = tools.parseEnvelope(entry);
        assert.deepEqual(result.to, [
            { name: 'Team', address: '' },
            { name: 'Member One', address: 'one@example.com' },
            { name: 'Member Two', address: 'two@example.com' }
        ]);
    });
    it('Tools: parseEnvelope does not join a NIL host onto a mailbox', () => {
        // Some servers parse a malformed header such as
        // "To: user@example.com user@example.com" into a personal name plus a mailbox
        // with a NIL host. Joining those produced the invalid address "example.com@".
        let entry: any = [
            null, // date
            null, // subject
            [], // from
            [], // sender
            [], // reply-to
            [[{ value: 'user@example.com user@' }, null, { value: 'example.com' }, null]], // to
            [], // cc
            [], // bcc
            null, // in-reply-to
            null // message-id
        ];

        let result = tools.parseEnvelope(entry);
        assert.deepEqual(result.to, [{ name: 'user@example.com user@', address: '' }]);
    });
    it('Tools: parseEnvelope decodes an encoded group name', () => {
        let entry: any = [
            null, // date
            null, // subject
            [], // from
            [], // sender
            [], // reply-to
            [[null, null, { value: '=?utf-8?Q?T=C3=B5ny?=' }, null]], // to
            [], // cc
            [], // bcc
            null, // in-reply-to
            null // message-id
        ];

        let result = tools.parseEnvelope(entry);
        assert.deepEqual(result.to, [{ name: 'Tõny', address: '' }]);
    });

    // ============================================
    // getStructuredParams tests
    // ============================================
    it('Tools: getStructuredParams with simple params', () => {
        let arr: any = [{ value: 'charset' }, { value: 'utf-8' }, { value: 'name' }, { value: 'file.txt' }];

        let result = tools.getStructuredParams(arr);
        assert.equal(result.charset, 'utf-8');
        assert.equal(result.name, 'file.txt');
    });
    it('Tools: getStructuredParams with null', () => {
        let result = tools.getStructuredParams(null);
        assert.deepEqual(result, {});
    });
    it('Tools: getStructuredParams with continuation', () => {
        // RFC 2231 continuation
        let arr: any = [{ value: 'filename*0' }, { value: 'very' }, { value: 'filename*1' }, { value: 'long' }, { value: 'filename*2' }, { value: 'name.txt' }];

        let result = tools.getStructuredParams(arr);
        assert.equal(result.filename, 'verylongname.txt');
    });

    // ============================================
    // parseBodystructure tests
    // ============================================
    it('Tools: parseBodystructure with simple text', () => {
        let entry: any = [
            { value: 'TEXT' },
            { value: 'PLAIN' },
            [{ value: 'CHARSET' }, { value: 'UTF-8' }],
            null, // id
            null, // description
            { value: '7BIT' }, // encoding
            { value: '1234' }, // size
            { value: '50' } // lines
        ];

        let result: any = tools.parseBodystructure(entry);
        assert.equal(result.type, 'text/plain');
        assert.equal(result.encoding, '7bit');
        assert.equal(result.size, 1234);
        assert.equal(result.parameters.charset, 'UTF-8');
    });
    it('Tools: parseBodystructure with multipart', () => {
        let textPart = [{ value: 'TEXT' }, { value: 'PLAIN' }, null, null, null, { value: '7BIT' }, { value: '100' }, { value: '5' }];

        let htmlPart = [{ value: 'TEXT' }, { value: 'HTML' }, null, null, null, { value: 'QUOTED-PRINTABLE' }, { value: '200' }, { value: '10' }];

        let entry: any = [textPart, htmlPart, { value: 'ALTERNATIVE' }];

        let result = tools.parseBodystructure(entry);
        assert.equal(result.type, 'multipart/alternative');
        assert.ok(Array.isArray(result.childNodes));
        assert.equal(result.childNodes.length, 2);
        assert.equal(result.childNodes[0].type, 'text/plain');
        assert.equal(result.childNodes[1].type, 'text/html');
    });
    it('Tools: parseBodystructure with attachment', () => {
        let entry: any = [
            { value: 'APPLICATION' },
            { value: 'PDF' },
            [{ value: 'NAME' }, { value: 'document.pdf' }],
            null,
            null,
            { value: 'BASE64' },
            { value: '50000' }
        ];

        let result: any = tools.parseBodystructure(entry);
        assert.equal(result.type, 'application/pdf');
        assert.equal(result.parameters.name, 'document.pdf');
    });
    it('Tools: parseBodystructure with md5', () => {
        // Non-text type with extension data including md5
        let entry: any = [
            { value: 'APPLICATION' },
            { value: 'OCTET-STREAM' },
            null, // params
            null, // id
            null, // description
            { value: 'BASE64' }, // encoding
            { value: '1000' }, // size
            { value: 'd41d8cd98f00b204e9800998ecf8427e' }, // md5
            null, // disposition
            null // language (to ensure we have enough elements)
        ];

        let result = tools.parseBodystructure(entry);
        assert.equal(result.type, 'application/octet-stream');
        assert.equal(result.md5, 'd41d8cd98f00b204e9800998ecf8427e');
    });
    it('Tools: parseBodystructure with language', () => {
        // Non-text type with language extension
        let entry: any = [
            { value: 'APPLICATION' },
            { value: 'PDF' },
            null, // params
            null, // id
            null, // description
            { value: 'BASE64' }, // encoding
            { value: '5000' }, // size
            null, // md5
            null, // disposition
            [{ value: 'EN' }, { value: 'DE' }], // language (array of values)
            null // location (to ensure enough elements)
        ];

        let result = tools.parseBodystructure(entry);
        assert.equal(result.type, 'application/pdf');
        assert.ok(Array.isArray(result.language));
        assert.deepEqual(result.language, ['en', 'de']);
    });
    it('Tools: parseBodystructure with location', () => {
        // Non-text type with location extension
        let entry: any = [
            { value: 'IMAGE' },
            { value: 'PNG' },
            null, // params
            null, // id
            null, // description
            { value: 'BASE64' }, // encoding
            { value: '10000' }, // size
            null, // md5
            null, // disposition
            null, // language
            { value: 'http://example.com/image.png' }, // location
            null // extra element to ensure we have enough
        ];

        let result = tools.parseBodystructure(entry);
        assert.equal(result.type, 'image/png');
        assert.equal(result.location, 'http://example.com/image.png');
    });
    it('Tools: parseBodystructure with all extension fields', () => {
        // Non-text type with all extension fields
        let entry: any = [
            { value: 'APPLICATION' },
            { value: 'ZIP' },
            [{ value: 'NAME' }, { value: 'archive.zip' }], // params
            { value: '<id123@example.com>' }, // id
            { value: 'A zip archive' }, // description
            { value: 'BASE64' }, // encoding
            { value: '50000' }, // size
            { value: 'abc123def456' }, // md5
            [{ value: 'ATTACHMENT' }, [{ value: 'FILENAME' }, { value: 'archive.zip' }]], // disposition with params
            [{ value: 'EN' }], // language
            { value: 'http://example.com/archive.zip' }, // location
            null // extra element
        ];

        let result: any = tools.parseBodystructure(entry);
        assert.equal(result.type, 'application/zip');
        assert.equal(result.parameters.name, 'archive.zip');
        assert.equal(result.id, '<id123@example.com>');
        assert.equal(result.description, 'A zip archive');
        assert.equal(result.encoding, 'base64');
        assert.equal(result.size, 50000);
        assert.equal(result.md5, 'abc123def456');
        assert.equal(result.disposition, 'attachment');
        assert.equal(result.dispositionParameters!.filename, 'archive.zip');
        assert.deepEqual(result.language, ['en']);
        assert.equal(result.location, 'http://example.com/archive.zip');
    });
    it('Tools: parseBodystructure with message/rfc822', () => {
        // message/rfc822 has special handling with envelope and nested bodystructure
        let nestedBody = [
            { value: 'TEXT' },
            { value: 'PLAIN' },
            [{ value: 'CHARSET' }, { value: 'UTF-8' }],
            null,
            null,
            { value: '7BIT' },
            { value: '500' },
            { value: '20' } // line count for text
        ];

        let envelope = [
            { value: 'Mon, 15 Jun 2023 10:00:00 +0000' }, // date
            { value: 'Nested Subject' }, // subject
            [[null, null, { value: 'sender' }, { value: 'example.com' }]], // from
            [],
            [],
            [],
            [],
            [], // sender, reply-to, to, cc, bcc
            null, // in-reply-to
            { value: '<nested@example.com>' } // message-id
        ];

        let entry: any = [
            { value: 'MESSAGE' },
            { value: 'RFC822' },
            null, // params
            null, // id
            null, // description
            { value: '7BIT' }, // encoding
            { value: '10000' }, // size
            envelope, // envelope
            nestedBody, // nested bodystructure
            { value: '100' }, // line count
            null, // md5
            null // disposition
        ];

        let result = tools.parseBodystructure(entry);
        assert.equal(result.type, 'message/rfc822');
        assert.equal(result.size, 10000);
        assert.equal(result.lineCount, 100);
        assert.ok(result.envelope);
        assert.equal(result.envelope.subject, 'Nested Subject');
        assert.ok(result.childNodes);
        assert.equal(result.childNodes.length, 1);
        assert.equal(result.childNodes[0].type, 'text/plain');
    });

    // ============================================
    // getDecoder tests
    // ============================================
    it('Tools: getDecoder with standard charset', () => {
        let decoder = tools.getDecoder('utf-8');
        assert.ok(decoder);
        assert.ok(typeof decoder.write === 'function');
    });
    it('Tools: getDecoder with Japanese charset', () => {
        let decoder = tools.getDecoder('iso-2022-jp');
        assert.ok(decoder);
        assert.equal(decoder.constructor.name, 'JPDecoder');
    });
    it('Tools: getDecoder with null/undefined', () => {
        let decoder = tools.getDecoder(null as any);
        assert.ok(decoder);
    });

    // ============================================
    // AuthenticationFailure tests
    // ============================================
    it('Tools: AuthenticationFailure error class', () => {
        let error = new tools.AuthenticationFailure('Auth failed');
        assert.ok(error instanceof Error);
        assert.equal(error.authenticationFailed, true);
        assert.equal(error.message, 'Auth failed');
    });

    // ============================================
    // enhanceCommandError tests
    // ============================================
    it('Tools: enhanceCommandError sets serverResponseCode', async () => {
        let err: any = new Error('Command failed');
        err.response = {
            tag: '*',
            command: 'NO',
            attributes: [
                {
                    type: 'SECTION',
                    section: [{ type: 'ATOM', value: 'NONEXISTENT' }]
                },
                { type: 'ATOM', value: 'Mailbox' },
                { type: 'ATOM', value: 'not' },
                { type: 'ATOM', value: 'found' }
            ]
        };
        let result = await tools.enhanceCommandError(err);
        assert.equal(result.serverResponseCode, 'NONEXISTENT');
        assert.equal(typeof result.response, 'string');
    });
    it('Tools: enhanceCommandError with no status code', async () => {
        let err: any = new Error('Command failed');
        err.response = { tag: '*', command: 'NO' };
        let result = await tools.enhanceCommandError(err);
        assert.ok(!result.serverResponseCode);
    });
    it('Tools: enhanceCommandError with null response', async () => {
        let err: any = new Error('Command failed');
        err.response = null;
        let result = await tools.enhanceCommandError(err);
        assert.equal(result.response, false);
    });

    // ============================================
    // getDecoder additional tests
    // ============================================
    it('Tools: getDecoder with eucjp charset', () => {
        let decoder = tools.getDecoder('eucjp');
        assert.ok(decoder);
        assert.equal(decoder.constructor.name, 'JPDecoder');
    });
    it('Tools: getDecoder with euc-jp (hyphenated) returns JPDecoder', () => {
        let decoder = tools.getDecoder('euc-jp');
        assert.ok(decoder);
        assert.equal(decoder.constructor.name, 'JPDecoder');
    });
    it('Tools: getDecoder with jis charset', () => {
        let decoder = tools.getDecoder('jis');
        assert.ok(decoder);
        assert.equal(decoder.constructor.name, 'JPDecoder');
    });
    it('Tools: getDecoder with windows-1252 returns iconv stream', () => {
        let decoder = tools.getDecoder('windows-1252');
        assert.ok(decoder);
        assert.notEqual(decoder.constructor.name, 'JPDecoder');
        assert.ok(typeof decoder.write === 'function');
    });
    it('Tools: getDecoder with no arg defaults to ascii', () => {
        let decoder = tools.getDecoder();
        assert.ok(decoder);
        assert.ok(typeof decoder.write === 'function');
    });

    // ============================================
    // getColorFlags tests
    // ============================================
    it('Tools: getColorFlags returns non-null for all valid colors', () => {
        let colors = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'grey'];
        for (let color of colors) {
            let result = tools.getColorFlags(color);
            assert.ok(result, `getColorFlags('${color}') should not be null`);
            assert.ok(Array.isArray(result.add), `${color} should have add array`);
            assert.ok(Array.isArray(result.remove), `${color} should have remove array`);
        }
    });
    it('Tools: getColorFlags red has Flagged but no MailFlagBit set', () => {
        let result: any = tools.getColorFlags('red');
        // red = index 0, all bits 0 — adds \\Flagged, removes all MailFlagBit flags
        assert.ok(result.add.includes('\\Flagged'));
        assert.ok(result!.remove.includes('$MailFlagBit0'));
        assert.ok(result!.remove.includes('$MailFlagBit1'));
        assert.ok(result!.remove.includes('$MailFlagBit2'));
    });
    it('Tools: getColorFlags orange has MailFlagBit0 set', () => {
        let result: any = tools.getColorFlags('orange');
        // orange = index 1, bit 0 set
        assert.ok(result.add.includes('\\Flagged'));
        assert.ok(result!.add.includes('$MailFlagBit0'));
        assert.ok(result!.remove.includes('$MailFlagBit1'));
        assert.ok(result!.remove.includes('$MailFlagBit2'));
    });
    it('Tools: getColorFlags yellow has MailFlagBit1 set', () => {
        let result: any = tools.getColorFlags('yellow');
        // yellow = index 2, bit 1 set
        assert.ok(result.add.includes('\\Flagged'));
        assert.ok(result!.add.includes('$MailFlagBit1'));
        assert.ok(result!.remove.includes('$MailFlagBit0'));
        assert.ok(result!.remove.includes('$MailFlagBit2'));
    });
    it('Tools: getColorFlags returns null for invalid color', () => {
        assert.equal(tools.getColorFlags('invalid'), null);
        assert.equal(tools.getColorFlags('pink'), null);
    });
    it('Tools: getColorFlags with null returns result not null', () => {
        // null input: colorCode becomes null, which is not < 0, so it falls through
        let result = tools.getColorFlags(null);
        assert.ok(result);
        assert.ok(result.remove.includes('\\Flagged'));
    });

    // ============================================
    // formatMessageResponse: OBJECTID NIL handling (RFC 8474)
    // ============================================
    it('Tools: formatMessageResponse handles THREADID NIL', async () => {
        // RFC 8474 allows `THREADID NIL` when the server has no thread relation to
        // report (e.g. Strato). The NIL token is parsed as null and must not crash.
        let untagged = await parser('* 1 FETCH (UID 1 EMAILID (E1) THREADID NIL FLAGS (\\Seen) MODSEQ (4312))');
        let result: any = await tools.formatMessageResponse(untagged, {} as any);
        assert.equal(result.seq, 1);
        assert.equal(result.uid, 1);
        assert.equal(result.emailId, 'E1');
        assert.equal(result.threadId, undefined);
        assert.ok(result.flags.has('\\Seen'));
        assert.equal(result.modseq, 4312n);
    });
    it('Tools: formatMessageResponse handles normal THREADID', async () => {
        let untagged = await parser('* 2 FETCH (THREADID (T9999) EMAILID (E2))');
        let result = await tools.formatMessageResponse(untagged, {} as any);
        assert.equal(result.threadId, 'T9999');
        assert.equal(result.emailId, 'E2');
    });

    // ============================================
    // formatMessageResponse: BINARY vs BODY part tracking (RFC 3516 / RFC 9051)
    // ============================================
    it('Tools: formatMessageResponse records which parts arrived via BINARY', async () => {
        // Parts answered as BINARY[...] arrive with the content-transfer-encoding
        // already decoded by the server; consumers (download/downloadMany) use the
        // binaryParts set to skip their own decoder for exactly those parts
        let untagged = await parser('* 1 FETCH (UID 7 BINARY[1] {4}\r\n BODY[2] {4}\r\n)', {
            literals: [Buffer.from('AAAA'), Buffer.from('BBBB')]
        });
        let result: any = await tools.formatMessageResponse(untagged, {} as any);
        assert.equal(result.bodyParts.get('1').toString(), 'AAAA');
        assert.equal(result.bodyParts!.get('2').toString(), 'BBBB');
        assert.ok(result.binaryParts, 'binaryParts set should exist when a BINARY part arrived');
        assert.ok(result.binaryParts.has('1'), 'BINARY-answered part is recorded');
        assert.ok(!result.binaryParts.has('2'), 'BODY-answered part is not recorded');
    });
    it('Tools: formatMessageResponse leaves binaryParts unset for plain BODY fetches', async () => {
        let untagged = await parser('* 1 FETCH (UID 8 BODY[1] {4}\r\n)', { literals: [Buffer.from('CCCC')] });
        let result: any = await tools.formatMessageResponse(untagged, {} as any);
        assert.equal(result.bodyParts.get('1').toString(), 'CCCC');
        assert.equal(result.binaryParts, undefined);
    });

    // ============================================
    // formatMessageResponse: non-ASCII mailbox path normalization for stable id
    // ============================================
    it('Tools: formatMessageResponse normalizes non-ASCII mailbox path for id', async () => {
        // No EMAILID, so the message id falls back to an md5 over [path, uidValidity, uid].
        // The mailbox path is non-ASCII and must be modified-UTF-7 normalized before hashing.
        // (A previous bogus regex /[0x80-0xff]/ never matched non-ASCII, skipping normalization.)
        let untagged = await parser('* 1 FETCH (UID 5 FLAGS (\\Seen))');
        let mailbox = { path: '日本語', uidValidity: 123n };
        let result = await tools.formatMessageResponse(untagged, mailbox as MailboxObject);

        let encodedPath = iconv.encode('日本語', 'utf-7-imap').toString();
        let expectedId = crypto.createHash('md5').update([encodedPath, '123', '5'].join(':')).digest('hex');
        let rawId = crypto.createHash('md5').update(['日本語', '123', '5'].join(':')).digest('hex');

        assert.equal(result.id, expectedId, 'id must hash the UTF-7 normalized path');
        assert.notEqual(result.id, rawId, 'id must not hash the raw non-ASCII path');
    });
    it('Tools: formatMessageResponse parses the full attribute set', async () => {
        let untagged = await parser(
            '* 3 FETCH (UID 100 RFC822.SIZE 5000 FLAGS (\\Seen \\Flagged) MODSEQ (12345) ' +
                'X-GM-MSGID 999 X-GM-THRID 888 X-GM-LABELS (\\Important Work) ' +
                'INTERNALDATE "12-Jan-2020 10:00:00 +0000" BODY[1] {3}\r\n BODY[HEADER] {2}\r\n)',
            { literals: [Buffer.from('abc'), Buffer.from('hi')] }
        );
        let mailbox: any = { path: 'INBOX', uidValidity: 1n }; // no uidNext/highestModseq -> exercise the bump branches
        let r: any = await tools.formatMessageResponse(untagged, mailbox as MailboxObject);
        assert.equal(r.uid, 100);
        assert.equal(r.size, 5000);
        assert.ok(r.flags.has('\\Seen'));
        assert.equal(r.modseq, 12345n);
        assert.equal(r.emailId, '999'); // X-GM-MSGID
        assert.equal(r.threadId, '888'); // X-GM-THRID
        assert.ok(r.labels!.has('Work'));
        assert.ok(r.internalDate instanceof Date);
        assert.ok(Buffer.isBuffer(r.headers));
        assert.ok(r.bodyParts!.get('1'));
        // mailbox estimates bumped from the FETCH data
        assert.equal(mailbox.uidNext, 101);
        assert.equal((mailbox as any).highestModseq, 12345n);
    });
    it('Tools: formatMessageResponse parses envelope and bodystructure', async () => {
        let untagged = await parser(
            '* 1 FETCH (ENVELOPE ("Mon, 2 Sep 2013 05:30:13 -0700" "Subject" ((NIL NIL "a" "b.com")) NIL NIL NIL NIL NIL NIL "<id@x>") ' +
                'BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" 12 0 NIL NIL NIL))'
        );
        let r = await tools.formatMessageResponse(untagged, { path: 'INBOX' } as MailboxObject);
        assert.ok(r.envelope);
        assert.equal(r.envelope.subject, 'Subject');
        assert.ok(r.bodyStructure);
        assert.equal(r.bodyStructure.type, 'text/plain');
    });
    it('Tools: formatMessageResponse source from BODY[] and BINARY[] literals', async () => {
        let untagged = await parser('* 1 FETCH (BODY[] {5}\r\n)', { literals: [Buffer.from('HELLO')] });
        let r = await tools.formatMessageResponse(untagged, { path: 'INBOX' } as MailboxObject);
        assert.ok(Buffer.isBuffer(r.source));
        assert.equal(r.source.toString(), 'HELLO');
    });
    it('Tools: formatMessageResponse keeps invalid INTERNALDATE as raw string', async () => {
        let untagged = await parser('* 1 FETCH (INTERNALDATE "not a date")');
        let r = await tools.formatMessageResponse(untagged, { path: 'INBOX' } as MailboxObject);
        assert.equal(r.internalDate, 'not a date');
    });
    it('Tools: parseEnvelope parses every field', async () => {
        let untagged: any = await parser(
            '* 1 FETCH (ENVELOPE ("Mon, 2 Sep 2013 05:30:13 -0700" "Hello" ' +
                '((NIL NIL "from" "x.com")) ((NIL NIL "sender" "x.com")) ((NIL NIL "reply" "x.com")) ' +
                '((NIL NIL "to" "x.com")) ((NIL NIL "cc" "x.com")) ((NIL NIL "bcc" "x.com")) ' +
                '"<inreplyto@x>" "<msgid@x>"))'
        );
        let env: any = tools.parseEnvelope(untagged.attributes[1][1] as any);
        assert.ok(env.date instanceof Date);
        assert.equal(env.subject, 'Hello');
        assert.equal(env.from[0].address, 'from@x.com');
        assert.equal(env.sender![0].address, 'sender@x.com');
        assert.equal(env.replyTo![0].address, 'reply@x.com');
        assert.equal(env.to![0].address, 'to@x.com');
        assert.equal(env.cc![0].address, 'cc@x.com');
        assert.equal(env.bcc![0].address, 'bcc@x.com');
        assert.equal(env.inReplyTo, '<inreplyto@x>');
        assert.equal(env.messageId, '<msgid@x>');
    });
    it('Tools: parseEnvelope keeps invalid date as string', async () => {
        let untagged: any = await parser('* 1 FETCH (ENVELOPE ("not a date" "Subj" NIL NIL NIL NIL NIL NIL NIL NIL))');
        let env = tools.parseEnvelope(untagged.attributes[1][1] as any);
        assert.equal(env.date, 'not a date');
    });
    it('Tools: parseBodystructure parses all single-part extension fields', async () => {
        let bs =
            '("TEXT" "PLAIN" ("CHARSET" "utf-8") "<cid@x>" "a description" "BASE64" 100 5 ' +
            '"d41d8cd9" ("attachment" ("filename" "f.txt")) ("en" "de") "http://loc/")';
        let untagged: any = await parser('* 1 FETCH (BODYSTRUCTURE ' + bs + ')');
        let node: any = tools.parseBodystructure(untagged.attributes[1][1] as any);
        assert.equal(node.type, 'text/plain');
        assert.equal(node.id, '<cid@x>');
        assert.equal(node.description, 'a description');
        assert.equal(node.encoding, 'base64');
        assert.equal(node.size, 100);
        assert.equal(node.lineCount, 5);
        assert.equal(node.md5, 'd41d8cd9');
        assert.equal(node.disposition, 'attachment');
        assert.equal(node.dispositionParameters.filename, 'f.txt');
        assert.deepEqual(node.language, ['en', 'de']);
    });
    it('Tools: parseBodystructure parses message/rfc822 with envelope and child', async () => {
        let bs =
            '("MESSAGE" "RFC822" NIL NIL NIL "7BIT" 200 ' +
            '("date" "subj" NIL NIL NIL NIL NIL NIL "<reply>" "<msgid>") ' +
            '("TEXT" "PLAIN" NIL NIL NIL "7BIT" 10 1) 3)';
        let untagged: any = await parser('* 1 FETCH (BODYSTRUCTURE ' + bs + ')');
        let node: any = tools.parseBodystructure(untagged.attributes[1][1] as any);
        assert.equal(node.type, 'message/rfc822');
        assert.ok(node.envelope);
        assert.equal(node.childNodes.length, 1);
        assert.equal(node.lineCount, 3);
    });
    it('Tools: parseBodystructure parses multipart with params and disposition', async () => {
        let bs = '(("TEXT" "PLAIN" NIL NIL NIL "7BIT" 10 1)("TEXT" "HTML" NIL NIL NIL "7BIT" 20 2) "ALTERNATIVE" ("BOUNDARY" "xyz") ("inline" NIL) ("en"))';
        let untagged: any = await parser('* 1 FETCH (BODYSTRUCTURE ' + bs + ')');
        let node: any = tools.parseBodystructure(untagged.attributes[1][1] as any);
        assert.equal(node.type, 'multipart/alternative');
        assert.equal(node.childNodes.length, 2);
        assert.equal(node.parameters!.boundary, 'xyz');
        assert.equal(node.disposition, 'inline');
    });
    it('Tools: formatMessageResponse handles NIL, Buffer and unknown keys', async () => {
        let untagged = await parser('* 1 FETCH (UID NIL RFC822.SIZE NIL X-GM-MSGID {3}\r\n BODY[] NIL FOOBAR 123)', {
            literals: [Buffer.from('999')]
        });
        let r = await tools.formatMessageResponse(untagged, { path: 'INBOX' } as MailboxObject);
        assert.equal(r.uid, undefined); // a NIL UID is left unset rather than reported as UID 0
        assert.equal(r.size, 0); // size keeps its 0 default

        assert.equal(r.emailId, '999'); // Buffer literal value -> getString stringifies it
        assert.equal(r.source, false); // BODY[] NIL -> getBuffer returns false
    });
    it('Tools: getFolderTree merges duplicate folder entries', () => {
        let tree: any = tools.getFolderTree([
            { name: 'Parent', path: 'Parent', parent: [], flags: new Set(['\\HasChildren']), delimiter: '/' },
            { name: 'Parent', path: 'Parent', parent: [], flags: new Set(['\\Noselect', '\\HasChildren']), specialUse: '\\Sent', delimiter: '/' }
        ] as any);
        assert.equal(tree.folders.length, 1);
        assert.equal(tree.folders![0].disabled, true);
        assert.equal(tree.folders![0].specialUse, '\\Sent');
    });
    it('Tools: parseBodystructure handles minimal NIL fields', async () => {
        let untagged: any = await parser('* 1 FETCH (BODYSTRUCTURE ("APPLICATION" "OCTET-STREAM" NIL NIL NIL NIL NIL))');
        let node = tools.parseBodystructure(untagged.attributes[1][1] as any);
        assert.equal(node.type, 'application/octet-stream');
        assert.equal(node.id, undefined);
        assert.equal(node.encoding, undefined);
    });
    it('Tools: parseBodystructure decodes RFC 2231 charset continuation params', async () => {
        let bs = '("TEXT" "PLAIN" ("name*0*" "utf-8\'\'%E2%82%AC abc" "name*1" "def") NIL NIL "7BIT" 10 1)';
        let untagged: any = await parser('* 1 FETCH (BODYSTRUCTURE ' + bs + ')');
        let node: any = tools.parseBodystructure(untagged.attributes[1][1] as any);
        assert.equal(node.parameters.name, '€ abcdef');
    });
    it('Tools: parseBodystructure handles empty-string extension fields', async () => {
        // Empty-string values exercise the `|| ''` / `|| 0` fallbacks in each field.
        let bs = '("TEXT" "PLAIN" ("CHARSET" "") "" "" "" 0 0 "" ("" ("" "")) ("") "")';
        let untagged: any = await parser('* 1 FETCH (BODYSTRUCTURE ' + bs + ')');
        let node = tools.parseBodystructure(untagged.attributes[1][1] as any);
        assert.equal(node.id, '');
        assert.equal(node.description, '');
        assert.equal(node.size, 0);
        assert.equal(node.md5, '');
        assert.deepEqual(node.language, ['']);
    });
    it('Tools: formatMessageResponse with no data list returns just seq', async () => {
        let untagged = await parser('* 5 FETCH');
        let r = await tools.formatMessageResponse(untagged, { path: 'INBOX' } as MailboxObject);
        assert.equal(r.seq, 5);
    });
    it('Tools: getFolderTree adds folders array when existing entry gains HasChildren', () => {
        let tree: any = tools.getFolderTree([
            { name: 'P', path: 'P', parent: [], flags: new Set([]), delimiter: '/' },
            { name: 'P', path: 'P', parent: [], flags: new Set(['\\HasChildren']), delimiter: '/' }
        ] as any);
        assert.ok(Array.isArray(tree.folders[0].folders), 'folders array created on merge');
    });
    it('Tools: normalizePath joins array with empty delimiter fallback', () => {
        // namespace present but without a delimiter -> the (... || '') fallback joins directly
        let connection: any = { namespace: { prefix: '' } };
        assert.equal(tools.normalizePath(connection, ['a', 'b']), 'ab');
    });
    it('Tools: updateCapabilities defaults non-numeric APPENDLIMIT to 0', () => {
        let caps = tools.updateCapabilities([{ value: 'APPENDLIMIT=abc' }] as any);
        assert.equal(caps.get('APPENDLIMIT'), 0);
    });
    it('Tools: formatMessageResponse skips non-string label entries', async () => {
        let untagged = await parser('* 1 FETCH (X-GM-LABELS (\\Important NIL))');
        let r: any = await tools.formatMessageResponse(untagged, { path: 'INBOX' } as MailboxObject);
        assert.deepEqual([...r.labels], ['\\Important']); // NIL entry filtered out
    });
    it('Tools: formatMessageResponse does not lower highestModseq', async () => {
        let mailbox = { path: 'INBOX', highestModseq: 99999n };
        let untagged = await parser('* 1 FETCH (MODSEQ (5) FLAGS (\\Seen))');
        await tools.formatMessageResponse(untagged, mailbox as MailboxObject);
        assert.equal(mailbox.highestModseq, 99999n); // unchanged: incoming modseq is lower
    });
    it('Tools: parseBodystructure multipart with NIL subtype', async () => {
        let untagged: any = await parser('* 1 FETCH (BODYSTRUCTURE (("TEXT" "PLAIN" NIL NIL NIL "7BIT" 1 1) NIL))');
        let node = tools.parseBodystructure(untagged.attributes[1][1] as any);
        assert.equal(node.type, 'multipart/');
    });
    it('Tools: parseBodystructure content type with NIL type/subtype', async () => {
        let untagged: any = await parser('* 1 FETCH (BODYSTRUCTURE (NIL NIL NIL NIL NIL "7BIT" 1))');
        let node = tools.parseBodystructure(untagged.attributes[1][1] as any);
        assert.equal(node.type, '/');
    });
    it('Tools: parseBodystructure message/rfc822 with NIL envelope/linecount', async () => {
        let bs = '("MESSAGE" "RFC822" NIL NIL NIL "7BIT" 100 NIL ("TEXT" "PLAIN" NIL NIL NIL "7BIT" 1 1) NIL NIL (NIL) NIL)';
        let untagged: any = await parser('* 1 FETCH (BODYSTRUCTURE ' + bs + ')');
        let node = tools.parseBodystructure(untagged.attributes[1][1] as any);
        assert.equal(node.type, 'message/rfc822');
    });
    it('Tools: parseBodystructure text with NIL language/location entries', async () => {
        let bs = '("TEXT" "PLAIN" NIL NIL NIL "7BIT" 100 NIL "md5" ("inline" NIL) (NIL) NIL)';
        let untagged: any = await parser('* 1 FETCH (BODYSTRUCTURE ' + bs + ')');
        let node = tools.parseBodystructure(untagged.attributes[1][1] as any);
        assert.deepEqual(node.language, ['']);
    });
    it('Tools: parseBodystructure empty-string size/linecount/language/location', async () => {
        let bs = '("TEXT" "PLAIN" NIL NIL NIL "7BIT" "" "" "" ("inline" NIL) ("") "")';
        let untagged: any = await parser('* 1 FETCH (BODYSTRUCTURE ' + bs + ')');
        let node = tools.parseBodystructure(untagged.attributes[1][1] as any);
        assert.equal(node.size, 0);
        assert.equal(node.lineCount, 0);
        assert.deepEqual(node.language, ['']);
    });
    it('Tools: parseBodystructure message/rfc822 empty-string linecount', async () => {
        let bs = '("MESSAGE" "RFC822" NIL NIL NIL "7BIT" 100 ("d" "s" NIL NIL NIL NIL NIL NIL NIL NIL) ("TEXT" "PLAIN" NIL NIL NIL "7BIT" 1 1) "")';
        let untagged: any = await parser('* 1 FETCH (BODYSTRUCTURE ' + bs + ')');
        let node = tools.parseBodystructure(untagged.attributes[1][1] as any);
        assert.equal(node.type, 'message/rfc822');
        assert.equal(node.lineCount, 0);
    });
    it('Tools: parseBodystructure decodes RFC 2231 with empty charset and special chars', async () => {
        // Empty charset before the first quote defaults to utf-8; '=' / '?' in the value
        // exercise the 2-char hex escape branch; the empty *1* continuation segment too.
        // value includes '=' / '?' (2-char hex escapes), a space (-> '_') and a TAB
        // (a <0x10 control char -> single-hex-digit escape needing a '0' pad).
        let bs = '("TEXT" "PLAIN" ("name*0*" "\'\'a=b?c d\te" "name*1*" "") NIL NIL "7BIT" 1 1)';
        let untagged: any = await parser('* 1 FETCH (BODYSTRUCTURE ' + bs + ')');
        let node: any = tools.parseBodystructure(untagged.attributes[1][1] as any);
        assert.ok(node.parameters.name.includes('a=b?c'));
    });
    it('Tools: parseBodystructure parses empty-string body location', async () => {
        // A trailing element after location makes the (i < length-1) guard pass so the
        // empty-string location value goes through the `|| ''` fallback.
        let bs = '("TEXT" "PLAIN" NIL NIL NIL "7BIT" 1 1 NIL NIL NIL "" NIL)';
        let untagged: any = await parser('* 1 FETCH (BODYSTRUCTURE ' + bs + ')');
        let node = tools.parseBodystructure(untagged.attributes[1][1] as any);
        assert.equal(node.location, '');
    });
    it('Tools: expandRange skips descending range to non-numeric second bound', () => {
        // Endpoints that are not valid nz-numbers make the whole entry invalid -
        // the pre-hardening behavior expanded '5:abc' down to 0
        assert.deepEqual(tools.expandRange('5:abc'), []);
    });
    it('Tools: expandRange skips non-numeric entries but keeps valid ones', () => {
        assert.deepEqual(tools.expandRange('abc,:5,1:3'), [1, 2, 3]);
    });
    it('Tools: expandRange handles descending ranges', () => {
        assert.deepEqual(tools.expandRange('5:3'), [5, 4, 3]);
    });
    it('Tools: encodePath keeps name as-is when iconv encode throws', () => {
        // The iconv module object is shared by reference; patch encode to throw so the
        // defensive catch is exercised, then restore.
        let original = iconv.encode;
        iconv.encode = () => {
            throw new Error('encode boom');
        };
        try {
            let connection: any = { enabled: new Set(), capabilities: new Map() };
            let result = tools.encodePath(connection, 'Tärä');
            assert.equal(result, 'Tärä', 'falls back to the raw path');
        } finally {
            iconv.encode = original;
        }
    });
    it('Tools: decodePath keeps name as-is when iconv decode throws', () => {
        let original = iconv.decode;
        iconv.decode = () => {
            throw new Error('decode boom');
        };
        try {
            let connection: any = { enabled: new Set(), capabilities: new Map() };
            let result = tools.decodePath(connection, 'Inbox&AOk-');
            assert.equal(result, 'Inbox&AOk-');
        } finally {
            iconv.decode = original;
        }
    });
    it('Tools: formatMessageResponse id falls back when iconv encode throws', async () => {
        let original = iconv.encode;
        iconv.encode = () => {
            throw new Error('encode boom');
        };
        try {
            let untagged = await parser('* 1 FETCH (UID 5 FLAGS (\\Seen))');
            // non-ASCII path triggers the encode branch; the throw is swallowed
            let r = await tools.formatMessageResponse(untagged, { path: 'Tärä', uidValidity: 1n } as MailboxObject);
            assert.ok(r.id, 'an id is still produced');
        } finally {
            iconv.encode = original;
        }
    });

    // ============================================
    // packMessageRange
    // ============================================
    it('Tools: packMessageRange packs contiguous and gapped ranges', () => {
        assert.equal(tools.packMessageRange([1, 2, 3, 5, 7, 8]), '1:3,5,7:8');
        assert.equal(tools.packMessageRange(7), '7');
        assert.equal(tools.packMessageRange([]), '');
    });
    it('Tools: packMessageRange dedupes duplicate values', () => {
        // Duplicates must not produce overlapping/non-canonical tokens like "1,1:3".
        assert.equal(tools.packMessageRange([1, 1, 2, 3]), '1:3');
        assert.equal(tools.packMessageRange([3, 1, 2, 2, 5]), '1:3,5');
        assert.equal(tools.packMessageRange([5, 5, 5]), '5');
    });

    // ============================================
    // Security regression tests: hostile server input
    // ============================================
    it('Tools: getStructuredParams drops __proto__ continuation parameters', () => {
        // A parameter named "__proto__*0*" groups under "__proto__": without a guard the
        // grouping wrote attacker-controlled values onto Object.prototype (and then threw)
        let result = tools.getStructuredParams([{ value: '__proto__*0*' }, { value: "utf-8''polluted" }] as any);
        assert.deepEqual(result, {});
        assert.equal(({} as any).charset, undefined, 'Object.prototype must stay clean');
    });
    it('Tools: getStructuredParams drops a plain __proto__ parameter', () => {
        // A plain "__proto__" parameter never reaches the output and never touches the prototype.
        // The string value alone cannot pollute (the __proto__ setter ignores primitives) - the
        // object-valued continuation form above is the case the live guard covers - so this
        // pins the output contract: the parameter is dropped, the rest of the list survives.
        let result = tools.getStructuredParams([{ value: '__proto__' }, { value: 'polluted' }, { value: 'a' }, { value: 'b' }] as any);
        assert.deepEqual(result, { a: 'b' });
        assert.ok(!Object.prototype.hasOwnProperty.call(result, '__proto__'), 'no own __proto__ property is created');
        assert.equal(Object.getPrototypeOf(result), Object.prototype, 'the prototype must stay untouched');
    });
    it('Tools: formatMessageResponse ignores a non-numeric MODSEQ', async () => {
        // BigInt() throws on garbage, and the throw used to drop the whole message
        // from the result set - a malformed MODSEQ must be skipped instead
        let untagged = await parser('* 1 FETCH (UID 1 MODSEQ (abc) FLAGS (\\Seen))');
        let result: any = await tools.formatMessageResponse(untagged, {} as any);
        assert.equal(result.uid, 1);
        assert.equal(result.modseq, undefined);
        assert.ok(result.flags.has('\\Seen'));

        // an unparenthesized MODSEQ yields no usable value either
        let untagged2 = await parser('* 1 FETCH (UID 1 MODSEQ 123)');
        let result2 = await tools.formatMessageResponse(untagged2, {} as any);
        assert.equal(result2.uid, 1);
        assert.equal(result2.modseq, undefined);
    });
    it('Tools: parseEnvelope skips NIL address entries', () => {
        // A NIL inside an address list used to throw on the dereference, dropping the message
        let entry: any = [
            null, // date
            null, // subject
            [null, [{ value: 'Name' }, null, { value: 'user' }, { value: 'example.com' }]], // from: NIL entry + valid entry
            [], // sender
            [], // reply-to
            [], // to
            [], // cc
            [], // bcc
            null, // in-reply-to
            null // message-id
        ];

        let result: any = tools.parseEnvelope(entry);
        assert.equal(result.from.length, 1);
        assert.equal(result.from![0].address, 'user@example.com');
    });

    // ============================================
    // Bounded parsing of untrusted numeric values
    // ============================================
    it('Tools: expandRange returns nothing for a non-string range', () => {
        // untaggedVanished() leaves the sequence set as `false` when the response carries only the
        // (EARLIER) tag, and throwing here would abort the handler for the rest of the response
        assert.deepEqual(tools.expandRange(false), []);
        assert.deepEqual(tools.expandRange(undefined), []);
        assert.deepEqual(tools.expandRange(null), []);
        assert.deepEqual(tools.expandRange(123), []);
        assert.deepEqual(tools.expandRange(['1:3']), []);
        assert.deepEqual(tools.expandRange('1:3'), [1, 2, 3], 'a real range still expands');
    });
    it('Tools: isDecimalString accepts only bounded digit runs', () => {
        assert.equal(tools.isDecimalString('12', 10), true);
        assert.equal(tools.isDecimalString('1234567890', 10), true);
        assert.equal(tools.isDecimalString('12345678901', 10), false, 'one digit past the bound is rejected');
        assert.equal(tools.isDecimalString('', 10), false);
        assert.equal(tools.isDecimalString('1e5', 10), false);
        assert.equal(tools.isDecimalString(' 12 ', 10), false);
        assert.equal(tools.isDecimalString('0x10', 10), false);
        assert.equal(tools.isDecimalString('-1', 10), false);
        assert.equal(tools.isDecimalString('1.5', 10), false);
        assert.equal(tools.isDecimalString(12, 10), false, 'only strings are accepted');
        assert.equal(tools.isDecimalString(null, 10), false);
    });
    it('Tools: parseBigIntValue rejects everything BigInt would throw on', () => {
        // isNaN() passes '1e5', ' 12 ' and 'Infinity'; BigInt() throws on all three, and the throw
        // propagates out of a response handler that was only trying to read one field
        assert.equal(tools.parseBigIntValue('9122'), 9122n);
        for (let bad of ['1e5', ' 12 ', 'Infinity', 'none', '', '-1', '1.5', null, undefined, 12, ['1']]) {
            assert.equal(tools.parseBigIntValue(bad), false, `${JSON.stringify(bad)} must be rejected`);
        }
    });
    it('Tools: parseBigIntValue bounds the digit count before converting', () => {
        // BigInt() on a multi-megabyte digit run costs hundreds of milliseconds of non-yielding
        // CPU, and a response line may carry up to maxLineLength digits
        assert.equal(tools.parseBigIntValue('9'.repeat(19)), BigInt('9'.repeat(19)), '63-bit values still fit the default bound');
        assert.equal(tools.parseBigIntValue('9'.repeat(20)), false);
        assert.equal(tools.parseBigIntValue('9'.repeat(400000)), false);
        assert.equal(tools.parseBigIntValue('12345678901', tools.MAX_UINT32_DIGITS), false, 'a tighter bound can be requested');
    });
    it('Tools: parseUintValue rejects values outside the safe integer range', () => {
        assert.equal(tools.parseUintValue('1000'), 1000);
        assert.equal(tools.parseUintValue('0'), 0);
        assert.equal(tools.parseUintValue('9'.repeat(19)), false, 'a value past 2^53-1 is refused, not rounded');
        assert.equal(tools.parseUintValue('9'.repeat(400)), false, 'a digit run that would coerce to Infinity is refused');
        for (let bad of ['1e3', '0x10', ' 12 ', '-5', '1.5', '']) {
            assert.equal(tools.parseUintValue(bad), false, `${JSON.stringify(bad)} must be rejected`);
        }
    });
    it('Tools: expandRange caps the total expansion, not just each range', () => {
        // A per-range bound alone is multiplied by an unbounded number of ranges. With the budget
        // already spent inside the second range, the two after it must be abandoned rather than
        // expanded on top of it.
        let result = tools.expandRange('1:16777215,16777215:16777220,1:5,7');
        assert.equal(result.length, tools.EXPANDED_RANGE_LIMIT);
        assert.equal(result[0], 1);
        // the second range gets the single remaining entry, and the two after it never start
        assert.equal(result[result.length - 1], 16777215);
    });
    it('Tools: formatMessageResponse drops an unusable sequence number', async () => {
        // Number('9'.repeat(400)) is Infinity, and a seq of Infinity indexes into nothing
        let untagged = await parser('* 1 FETCH (UID 5)');
        let ok = await tools.formatMessageResponse(untagged, { path: 'INBOX' } as MailboxObject);
        assert.equal(ok.seq, 1);

        let overflowing = await tools.formatMessageResponse({ command: '9'.repeat(400), attributes: [] }, { path: 'INBOX' } as MailboxObject);
        assert.equal(overflowing.seq, undefined);
    });
});
