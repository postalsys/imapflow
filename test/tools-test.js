'use strict';

const tools = require('../lib/tools');
const { parser } = require('../lib/handler/imap-handler');
const crypto = require('crypto');
const iconv = require('iconv-lite');

// Mock connection for testing
let createMockConnection = (options = {}) => ({
    enabled: new Set(options.utf8 ? ['UTF8=ACCEPT'] : []),
    namespace: options.namespace || null
});

// ============================================
// encodePath / decodePath tests
// ============================================

module.exports['Tools: encodePath with ASCII path'] = test => {
    let connection = createMockConnection();
    let result = tools.encodePath(connection, 'INBOX');
    test.equal(result, 'INBOX');
    test.done();
};

module.exports['Tools: encodePath with Unicode path (no UTF8)'] = test => {
    let connection = createMockConnection({ utf8: false });
    let result = tools.encodePath(connection, 'Sent/Gesendete');
    // ASCII path should remain unchanged
    test.equal(result, 'Sent/Gesendete');
    test.done();
};

module.exports['Tools: encodePath with Unicode when UTF8=ACCEPT enabled'] = test => {
    let connection = createMockConnection({ utf8: true });
    let result = tools.encodePath(connection, 'Posteingang/Ordner');
    // With UTF8=ACCEPT, path should remain unchanged
    test.equal(result, 'Posteingang/Ordner');
    test.done();
};

module.exports['Tools: encodePath with null/undefined'] = test => {
    let connection = createMockConnection();
    test.equal(tools.encodePath(connection, null), '');
    test.equal(tools.encodePath(connection, undefined), '');
    test.done();
};

module.exports['Tools: decodePath with ASCII path'] = test => {
    let connection = createMockConnection();
    let result = tools.decodePath(connection, 'INBOX');
    test.equal(result, 'INBOX');
    test.done();
};

module.exports['Tools: decodePath with ampersand'] = test => {
    let connection = createMockConnection({ utf8: false });
    // UTF-7-IMAP encoded string
    let result = tools.decodePath(connection, 'Test&-Folder');
    test.ok(typeof result === 'string');
    test.done();
};

module.exports['Tools: decodePath with UTF8=ACCEPT enabled'] = test => {
    let connection = createMockConnection({ utf8: true });
    let result = tools.decodePath(connection, 'Test&Folder');
    // With UTF8=ACCEPT, should not decode
    test.equal(result, 'Test&Folder');
    test.done();
};

module.exports['Tools: decodePath with null/undefined'] = test => {
    let connection = createMockConnection();
    test.equal(tools.decodePath(connection, null), '');
    test.equal(tools.decodePath(connection, undefined), '');
    test.done();
};

// ============================================
// normalizePath tests
// ============================================

module.exports['Tools: normalizePath with INBOX (case insensitive)'] = test => {
    let connection = createMockConnection();
    test.equal(tools.normalizePath(connection, 'inbox'), 'INBOX');
    test.equal(tools.normalizePath(connection, 'INBOX'), 'INBOX');
    test.equal(tools.normalizePath(connection, 'InBox'), 'INBOX');
    test.done();
};

module.exports['Tools: normalizePath with array path'] = test => {
    let connection = createMockConnection({
        namespace: { delimiter: '/', prefix: '' }
    });
    let result = tools.normalizePath(connection, ['Folder', 'Subfolder']);
    test.equal(result, 'Folder/Subfolder');
    test.done();
};

module.exports['Tools: normalizePath with namespace prefix'] = test => {
    let connection = createMockConnection({
        namespace: { delimiter: '.', prefix: 'INBOX.' }
    });
    let result = tools.normalizePath(connection, 'Sent');
    test.equal(result, 'INBOX.Sent');
    test.done();
};

module.exports['Tools: normalizePath skip namespace'] = test => {
    let connection = createMockConnection({
        namespace: { delimiter: '.', prefix: 'INBOX.' }
    });
    let result = tools.normalizePath(connection, 'Sent', true);
    test.equal(result, 'Sent');
    test.done();
};

module.exports['Tools: normalizePath already has prefix'] = test => {
    let connection = createMockConnection({
        namespace: { delimiter: '.', prefix: 'INBOX.' }
    });
    let result = tools.normalizePath(connection, 'INBOX.Sent');
    test.equal(result, 'INBOX.Sent');
    test.done();
};

// ============================================
// comparePaths tests
// ============================================

module.exports['Tools: comparePaths equal paths'] = test => {
    let connection = createMockConnection();
    test.equal(tools.comparePaths(connection, 'INBOX', 'INBOX'), true);
    test.equal(tools.comparePaths(connection, 'inbox', 'INBOX'), true);
    test.done();
};

module.exports['Tools: comparePaths different paths'] = test => {
    let connection = createMockConnection();
    test.equal(tools.comparePaths(connection, 'INBOX', 'Sent'), false);
    test.done();
};

module.exports['Tools: comparePaths with null/undefined'] = test => {
    let connection = createMockConnection();
    test.equal(tools.comparePaths(connection, null, 'INBOX'), false);
    test.equal(tools.comparePaths(connection, 'INBOX', null), false);
    test.equal(tools.comparePaths(connection, null, null), false);
    test.done();
};

// ============================================
// updateCapabilities tests
// ============================================

module.exports['Tools: updateCapabilities with valid list'] = test => {
    let list = [{ value: 'IMAP4rev1' }, { value: 'IDLE' }, { value: 'NAMESPACE' }];
    let result = tools.updateCapabilities(list);
    test.ok(result instanceof Map);
    test.equal(result.get('IMAP4rev1'), true);
    test.equal(result.get('IDLE'), true);
    test.equal(result.get('NAMESPACE'), true);
    test.done();
};

module.exports['Tools: updateCapabilities with APPENDLIMIT'] = test => {
    let list = [{ value: 'APPENDLIMIT=52428800' }];
    let result = tools.updateCapabilities(list);
    test.equal(result.get('APPENDLIMIT'), 52428800);
    test.done();
};

module.exports['Tools: updateCapabilities with empty/null list'] = test => {
    test.ok(tools.updateCapabilities(null) instanceof Map);
    test.ok(tools.updateCapabilities([]) instanceof Map);
    test.ok(tools.updateCapabilities(undefined) instanceof Map);
    test.done();
};

module.exports['Tools: updateCapabilities skips non-string values'] = test => {
    let list = [{ value: 'IDLE' }, { value: 123 }, { value: null }];
    let result = tools.updateCapabilities(list);
    test.equal(result.get('IDLE'), true);
    test.equal(result.size, 1);
    test.done();
};

// ============================================
// getStatusCode tests
// ============================================

module.exports['Tools: getStatusCode with valid response'] = test => {
    let response = {
        attributes: [
            {
                section: [{ value: 'TRYCREATE' }]
            }
        ]
    };
    test.equal(tools.getStatusCode(response), 'TRYCREATE');
    test.done();
};

module.exports['Tools: getStatusCode with null/invalid response'] = test => {
    test.equal(tools.getStatusCode(null), false);
    test.equal(tools.getStatusCode({}), false);
    test.equal(tools.getStatusCode({ attributes: [] }), false);
    test.equal(tools.getStatusCode({ attributes: [{}] }), false);
    test.done();
};

// ============================================
// getErrorText tests
// ============================================

module.exports['Tools: getErrorText with null response'] = async test => {
    let result = await tools.getErrorText(null);
    test.equal(result, false);
    test.done();
};

module.exports['Tools: getErrorText with valid response'] = async test => {
    let response = {
        tag: '*',
        command: 'OK',
        attributes: [{ type: 'TEXT', value: 'Success' }]
    };
    let result = await tools.getErrorText(response);
    test.ok(typeof result === 'string');
    test.done();
};

// ============================================
// getFlagColor tests
// ============================================

module.exports['Tools: getFlagColor without Flagged'] = test => {
    let flags = new Set(['\\Seen']);
    test.equal(tools.getFlagColor(flags), null);
    test.done();
};

module.exports['Tools: getFlagColor with Flagged only (red)'] = test => {
    let flags = new Set(['\\Flagged']);
    test.equal(tools.getFlagColor(flags), 'red');
    test.done();
};

module.exports['Tools: getFlagColor with color bits'] = test => {
    // bit0=1, bit1=0, bit2=0 => orange (index 1)
    let flags = new Set(['\\Flagged', '$MailFlagBit0']);
    test.equal(tools.getFlagColor(flags), 'orange');

    // bit0=0, bit1=1, bit2=0 => yellow (index 2)
    flags = new Set(['\\Flagged', '$MailFlagBit1']);
    test.equal(tools.getFlagColor(flags), 'yellow');

    // bit0=1, bit1=1, bit2=0 => green (index 3)
    flags = new Set(['\\Flagged', '$MailFlagBit0', '$MailFlagBit1']);
    test.equal(tools.getFlagColor(flags), 'green');

    // bit0=0, bit1=0, bit2=1 => blue (index 4)
    flags = new Set(['\\Flagged', '$MailFlagBit2']);
    test.equal(tools.getFlagColor(flags), 'blue');

    // bit0=1, bit1=0, bit2=1 => purple (index 5)
    flags = new Set(['\\Flagged', '$MailFlagBit0', '$MailFlagBit2']);
    test.equal(tools.getFlagColor(flags), 'purple');

    // bit0=0, bit1=1, bit2=1 => grey (index 6)
    flags = new Set(['\\Flagged', '$MailFlagBit1', '$MailFlagBit2']);
    test.equal(tools.getFlagColor(flags), 'grey');

    test.done();
};

module.exports['Tools: getFlagColor with all bits set (index 7) defaults to red'] = test => {
    // bit0=1, bit1=2, bit2=4 => color=7, FLAG_COLORS[7] is undefined => defaults to 'red'
    let flags = new Set(['\\Flagged', '$MailFlagBit0', '$MailFlagBit1', '$MailFlagBit2']);
    test.equal(tools.getFlagColor(flags), 'red');
    test.done();
};

// ============================================
// getColorFlags tests
// ============================================

module.exports['Tools: getColorFlags with valid color'] = test => {
    // 'orange' is index 1, which is truthy
    let result = tools.getColorFlags('orange');
    test.ok(Array.isArray(result.add));
    test.ok(Array.isArray(result.remove));
    test.ok(result.add.includes('\\Flagged'));
    test.done();
};

module.exports['Tools: getColorFlags with red (index 0)'] = test => {
    // 'red' is index 0 — should add \\Flagged and remove all MailFlagBit flags
    let result = tools.getColorFlags('red');
    test.ok(Array.isArray(result.add));
    test.ok(Array.isArray(result.remove));
    test.ok(result.add.includes('\\Flagged'));
    test.done();
};

module.exports['Tools: getColorFlags with null (remove flag)'] = test => {
    let result = tools.getColorFlags(null);
    test.ok(result.remove.includes('\\Flagged'));
    test.done();
};

module.exports['Tools: getColorFlags with invalid color'] = test => {
    let result = tools.getColorFlags('invalid-color');
    test.equal(result, null);
    test.done();
};

module.exports['Tools: getColorFlags sets correct bits'] = test => {
    // orange = index 1 = bit0 set
    let result = tools.getColorFlags('orange');
    test.ok(result.add.includes('$MailFlagBit0'));
    test.ok(result.remove.includes('$MailFlagBit1'));
    test.ok(result.remove.includes('$MailFlagBit2'));

    // green = index 3 = bit0 + bit1 set
    result = tools.getColorFlags('green');
    test.ok(result.add.includes('$MailFlagBit0'));
    test.ok(result.add.includes('$MailFlagBit1'));
    test.ok(result.remove.includes('$MailFlagBit2'));

    test.done();
};

// ============================================
// isDate tests
// ============================================

module.exports['Tools: isDate with Date object'] = test => {
    test.equal(tools.isDate(new Date()), true);
    test.equal(tools.isDate(new Date('2023-01-01')), true);
    test.done();
};

module.exports['Tools: isDate with non-Date'] = test => {
    test.equal(tools.isDate('2023-01-01'), false);
    test.equal(tools.isDate(12345), false);
    test.equal(tools.isDate(null), false);
    test.equal(tools.isDate({}), false);
    test.done();
};

// ============================================
// formatDate tests
// ============================================

module.exports['Tools: formatDate with Date object'] = test => {
    let date = new Date('2023-06-15T00:00:00.000Z');
    let result = tools.formatDate(date);
    test.equal(result, '15-Jun-2023');
    test.done();
};

module.exports['Tools: formatDate with string'] = test => {
    let result = tools.formatDate('2023-06-15');
    test.equal(result, '15-Jun-2023');
    test.done();
};

module.exports['Tools: formatDate with invalid date'] = test => {
    let result = tools.formatDate('invalid');
    test.equal(result, undefined);
    test.done();
};

// ============================================
// formatDateTime tests
// ============================================

module.exports['Tools: formatDateTime with Date object'] = test => {
    let date = new Date('2023-06-15T14:30:45.000Z');
    let result = tools.formatDateTime(date);
    test.ok(result.includes('Jun-2023'));
    test.ok(result.includes('14:30:45'));
    test.ok(result.includes('+0000'));
    test.done();
};

module.exports['Tools: formatDateTime with null/undefined'] = test => {
    test.equal(tools.formatDateTime(null), undefined);
    test.equal(tools.formatDateTime(undefined), undefined);
    test.done();
};

module.exports['Tools: formatDateTime with string'] = test => {
    let result = tools.formatDateTime('2023-06-15T10:00:00Z');
    test.ok(typeof result === 'string');
    test.ok(result.includes('Jun-2023'));
    test.done();
};

module.exports['Tools: formatDateTime with invalid date string'] = test => {
    let result = tools.formatDateTime('invalid-date-string');
    test.equal(result, undefined);
    test.done();
};

// ============================================
// formatFlag tests
// ============================================

module.exports['Tools: formatFlag with standard flags'] = test => {
    test.equal(tools.formatFlag('\\Seen'), '\\Seen');
    test.equal(tools.formatFlag('\\SEEN'), '\\Seen');
    test.equal(tools.formatFlag('\\answered'), '\\Answered');
    test.equal(tools.formatFlag('\\flagged'), '\\Flagged');
    test.equal(tools.formatFlag('\\deleted'), '\\Deleted');
    test.equal(tools.formatFlag('\\draft'), '\\Draft');
    test.done();
};

module.exports['Tools: formatFlag with Recent (cannot set)'] = test => {
    test.equal(tools.formatFlag('\\Recent'), false);
    test.equal(tools.formatFlag('\\recent'), false);
    test.done();
};

module.exports['Tools: formatFlag with custom flags'] = test => {
    test.equal(tools.formatFlag('$CustomFlag'), '$CustomFlag');
    test.equal(tools.formatFlag('MyFlag'), 'MyFlag');
    test.done();
};

// ============================================
// canUseFlag tests
// ============================================

module.exports['Tools: canUseFlag with no mailbox'] = test => {
    test.equal(tools.canUseFlag(null, '\\Seen'), true);
    test.done();
};

module.exports['Tools: canUseFlag with wildcard permanent flags'] = test => {
    let mailbox = { permanentFlags: new Set(['\\*']) };
    test.equal(tools.canUseFlag(mailbox, '\\Seen'), true);
    test.equal(tools.canUseFlag(mailbox, '$CustomFlag'), true);
    test.done();
};

module.exports['Tools: canUseFlag with specific permanent flags'] = test => {
    let mailbox = { permanentFlags: new Set(['\\Seen', '\\Flagged']) };
    test.equal(tools.canUseFlag(mailbox, '\\Seen'), true);
    test.equal(tools.canUseFlag(mailbox, '\\Flagged'), true);
    test.equal(tools.canUseFlag(mailbox, '\\Deleted'), false);
    test.done();
};

module.exports['Tools: canUseFlag with no permanent flags'] = test => {
    let mailbox = { permanentFlags: null };
    test.equal(tools.canUseFlag(mailbox, '\\Seen'), true);
    test.done();
};

// ============================================
// expandRange tests
// ============================================

module.exports['Tools: expandRange with single values'] = test => {
    let result = tools.expandRange('1,2,3');
    test.deepEqual(result, [1, 2, 3]);
    test.done();
};

module.exports['Tools: expandRange with range'] = test => {
    let result = tools.expandRange('1:5');
    test.deepEqual(result, [1, 2, 3, 4, 5]);
    test.done();
};

module.exports['Tools: expandRange with reverse range'] = test => {
    let result = tools.expandRange('5:1');
    test.deepEqual(result, [5, 4, 3, 2, 1]);
    test.done();
};

module.exports['Tools: expandRange with mixed'] = test => {
    let result = tools.expandRange('1,3:5,10');
    test.deepEqual(result, [1, 3, 4, 5, 10]);
    test.done();
};

module.exports['Tools: expandRange with same start/end'] = test => {
    let result = tools.expandRange('5:5');
    test.deepEqual(result, [5]);
    test.done();
};

// ============================================
// packMessageRange tests
// ============================================

module.exports['Tools: packMessageRange with sequential numbers'] = test => {
    let result = tools.packMessageRange([1, 2, 3, 4, 5]);
    test.equal(result, '1:5');
    test.done();
};

module.exports['Tools: packMessageRange with gaps'] = test => {
    let result = tools.packMessageRange([1, 2, 3, 7, 8, 9]);
    test.equal(result, '1:3,7:9');
    test.done();
};

module.exports['Tools: packMessageRange with single values'] = test => {
    let result = tools.packMessageRange([1, 5, 10]);
    test.equal(result, '1,5,10');
    test.done();
};

module.exports['Tools: packMessageRange with unsorted input'] = test => {
    let result = tools.packMessageRange([5, 1, 3, 2, 4]);
    test.equal(result, '1:5');
    test.done();
};

module.exports['Tools: packMessageRange with empty array'] = test => {
    test.equal(tools.packMessageRange([]), '');
    test.done();
};

module.exports['Tools: packMessageRange with non-array'] = test => {
    test.equal(tools.packMessageRange(5), '5');
    test.equal(tools.packMessageRange(null), '');
    test.done();
};

// ============================================
// processName tests
// ============================================

module.exports['Tools: processName with quoted string'] = test => {
    test.equal(tools.processName('"John Doe"'), 'John Doe');
    test.done();
};

module.exports['Tools: processName with unquoted string'] = test => {
    test.equal(tools.processName('John Doe'), 'John Doe');
    test.done();
};

module.exports['Tools: processName with null/undefined'] = test => {
    test.equal(tools.processName(null), '');
    test.equal(tools.processName(undefined), '');
    test.done();
};

module.exports['Tools: processName with short quoted'] = test => {
    // String too short to have quotes removed (less than 3 chars)
    test.equal(tools.processName('""'), '""');
    test.equal(tools.processName('"a"'), 'a');
    test.done();
};

// ============================================
// getFolderTree tests
// ============================================

module.exports['Tools: getFolderTree with flat folders'] = test => {
    let folders = [
        { name: 'INBOX', path: 'INBOX', flags: new Set(), parent: [] },
        { name: 'Sent', path: 'Sent', flags: new Set(), parent: [] }
    ];
    let tree = tools.getFolderTree(folders);

    test.ok(tree.root);
    test.ok(Array.isArray(tree.folders));
    test.equal(tree.folders.length, 2);
    test.done();
};

module.exports['Tools: getFolderTree with nested folders'] = test => {
    let folders = [
        { name: 'INBOX', path: 'INBOX', flags: new Set(['\\HasChildren']), parent: [] },
        { name: 'Work', path: 'INBOX/Work', flags: new Set(), parent: ['INBOX'] }
    ];
    let tree = tools.getFolderTree(folders);

    test.ok(tree.root);
    test.equal(tree.folders.length, 1);
    test.equal(tree.folders[0].name, 'INBOX');
    test.ok(Array.isArray(tree.folders[0].folders));
    test.done();
};

module.exports['Tools: getFolderTree with Noselect flag'] = test => {
    let folders = [{ name: 'Archive', path: 'Archive', flags: new Set(['\\Noselect']), parent: [] }];
    let tree = tools.getFolderTree(folders);

    test.equal(tree.folders[0].disabled, true);
    test.done();
};

module.exports['Tools: getFolderTree with specialUse'] = test => {
    let folders = [{ name: 'Sent', path: 'Sent', flags: new Set(), parent: [], specialUse: '\\Sent' }];
    let tree = tools.getFolderTree(folders);

    test.equal(tree.folders[0].specialUse, '\\Sent');
    test.done();
};

module.exports['Tools: getFolderTree with delimiter'] = test => {
    let folders = [{ name: 'Folder', path: 'Folder', flags: new Set(), parent: [], delimiter: '/' }];
    let tree = tools.getFolderTree(folders);

    test.equal(tree.folders[0].delimiter, '/');
    test.done();
};

module.exports['Tools: getFolderTree updates existing entries'] = test => {
    let folders = [
        { name: 'INBOX', path: 'INBOX', flags: new Set(['\\HasChildren']), parent: [], listed: true },
        { name: 'INBOX', path: 'INBOX', flags: new Set(['\\HasChildren']), parent: [], subscribed: true }
    ];
    let tree = tools.getFolderTree(folders);

    // Should update the existing entry, not create duplicate
    test.equal(tree.folders.length, 1);
    test.done();
};

// ============================================
// parseEnvelope tests
// ============================================

module.exports['Tools: parseEnvelope with complete envelope'] = test => {
    let entry = [
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

    let result = tools.parseEnvelope(entry);

    test.ok(result.date instanceof Date);
    test.equal(result.subject, 'Test Subject');
    test.equal(result.from[0].address, 'sender@example.com');
    test.equal(result.to[0].address, 'to@example.com');
    test.equal(result.messageId, '<message-id@example.com>');
    test.done();
};

module.exports['Tools: parseEnvelope with minimal envelope'] = test => {
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
    test.ok(typeof result === 'object');
    test.equal(result.subject, undefined);
    test.done();
};

module.exports['Tools: parseEnvelope with invalid date'] = test => {
    let entry = [{ value: 'invalid-date' }, null, null, null, null, null, null, null, null, null];

    let result = tools.parseEnvelope(entry);
    test.equal(result.date, 'invalid-date');
    test.done();
};

module.exports['Tools: parseEnvelope with Buffer value'] = test => {
    let entry = [
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

    let result = tools.parseEnvelope(entry);
    test.equal(result.subject, 'Buffer Subject');
    test.equal(result.from[0].address, 'sender@example.com');
    test.equal(result.messageId, '<msg-id@example.com>');
    test.done();
};

module.exports['Tools: parseEnvelope with empty address parts'] = test => {
    // When both local part and domain are null/empty, address should be empty string
    let entry = [
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
    test.ok(result.from);
    // The entry has a name but no valid address, should still be included with empty address
    test.equal(result.from.length, 1);
    test.equal(result.from[0].name, 'Group Name');
    test.equal(result.from[0].address, '');
    test.done();
};

// ============================================
// getStructuredParams tests
// ============================================

module.exports['Tools: getStructuredParams with simple params'] = test => {
    let arr = [{ value: 'charset' }, { value: 'utf-8' }, { value: 'name' }, { value: 'file.txt' }];

    let result = tools.getStructuredParams(arr);
    test.equal(result.charset, 'utf-8');
    test.equal(result.name, 'file.txt');
    test.done();
};

module.exports['Tools: getStructuredParams with null'] = test => {
    let result = tools.getStructuredParams(null);
    test.deepEqual(result, {});
    test.done();
};

module.exports['Tools: getStructuredParams with continuation'] = test => {
    // RFC 2231 continuation
    let arr = [{ value: 'filename*0' }, { value: 'very' }, { value: 'filename*1' }, { value: 'long' }, { value: 'filename*2' }, { value: 'name.txt' }];

    let result = tools.getStructuredParams(arr);
    test.equal(result.filename, 'verylongname.txt');
    test.done();
};

// ============================================
// parseBodystructure tests
// ============================================

module.exports['Tools: parseBodystructure with simple text'] = test => {
    let entry = [
        { value: 'TEXT' },
        { value: 'PLAIN' },
        [{ value: 'CHARSET' }, { value: 'UTF-8' }],
        null, // id
        null, // description
        { value: '7BIT' }, // encoding
        { value: '1234' }, // size
        { value: '50' } // lines
    ];

    let result = tools.parseBodystructure(entry);
    test.equal(result.type, 'text/plain');
    test.equal(result.encoding, '7bit');
    test.equal(result.size, 1234);
    test.equal(result.parameters.charset, 'UTF-8');
    test.done();
};

module.exports['Tools: parseBodystructure with multipart'] = test => {
    let textPart = [{ value: 'TEXT' }, { value: 'PLAIN' }, null, null, null, { value: '7BIT' }, { value: '100' }, { value: '5' }];

    let htmlPart = [{ value: 'TEXT' }, { value: 'HTML' }, null, null, null, { value: 'QUOTED-PRINTABLE' }, { value: '200' }, { value: '10' }];

    let entry = [textPart, htmlPart, { value: 'ALTERNATIVE' }];

    let result = tools.parseBodystructure(entry);
    test.equal(result.type, 'multipart/alternative');
    test.ok(Array.isArray(result.childNodes));
    test.equal(result.childNodes.length, 2);
    test.equal(result.childNodes[0].type, 'text/plain');
    test.equal(result.childNodes[1].type, 'text/html');
    test.done();
};

module.exports['Tools: parseBodystructure with attachment'] = test => {
    let entry = [
        { value: 'APPLICATION' },
        { value: 'PDF' },
        [{ value: 'NAME' }, { value: 'document.pdf' }],
        null,
        null,
        { value: 'BASE64' },
        { value: '50000' }
    ];

    let result = tools.parseBodystructure(entry);
    test.equal(result.type, 'application/pdf');
    test.equal(result.parameters.name, 'document.pdf');
    test.done();
};

module.exports['Tools: parseBodystructure with md5'] = test => {
    // Non-text type with extension data including md5
    let entry = [
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
    test.equal(result.type, 'application/octet-stream');
    test.equal(result.md5, 'd41d8cd98f00b204e9800998ecf8427e');
    test.done();
};

module.exports['Tools: parseBodystructure with language'] = test => {
    // Non-text type with language extension
    let entry = [
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
    test.equal(result.type, 'application/pdf');
    test.ok(Array.isArray(result.language));
    test.deepEqual(result.language, ['en', 'de']);
    test.done();
};

module.exports['Tools: parseBodystructure with location'] = test => {
    // Non-text type with location extension
    let entry = [
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
    test.equal(result.type, 'image/png');
    test.equal(result.location, 'http://example.com/image.png');
    test.done();
};

module.exports['Tools: parseBodystructure with all extension fields'] = test => {
    // Non-text type with all extension fields
    let entry = [
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

    let result = tools.parseBodystructure(entry);
    test.equal(result.type, 'application/zip');
    test.equal(result.parameters.name, 'archive.zip');
    test.equal(result.id, '<id123@example.com>');
    test.equal(result.description, 'A zip archive');
    test.equal(result.encoding, 'base64');
    test.equal(result.size, 50000);
    test.equal(result.md5, 'abc123def456');
    test.equal(result.disposition, 'attachment');
    test.equal(result.dispositionParameters.filename, 'archive.zip');
    test.deepEqual(result.language, ['en']);
    test.equal(result.location, 'http://example.com/archive.zip');
    test.done();
};

module.exports['Tools: parseBodystructure with message/rfc822'] = test => {
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

    let entry = [
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
    test.equal(result.type, 'message/rfc822');
    test.equal(result.size, 10000);
    test.equal(result.lineCount, 100);
    test.ok(result.envelope);
    test.equal(result.envelope.subject, 'Nested Subject');
    test.ok(result.childNodes);
    test.equal(result.childNodes.length, 1);
    test.equal(result.childNodes[0].type, 'text/plain');
    test.done();
};

// ============================================
// getDecoder tests
// ============================================

module.exports['Tools: getDecoder with standard charset'] = test => {
    let decoder = tools.getDecoder('utf-8');
    test.ok(decoder);
    test.ok(typeof decoder.write === 'function');
    test.done();
};

module.exports['Tools: getDecoder with Japanese charset'] = test => {
    let decoder = tools.getDecoder('iso-2022-jp');
    test.ok(decoder);
    test.equal(decoder.constructor.name, 'JPDecoder');
    test.done();
};

module.exports['Tools: getDecoder with null/undefined'] = test => {
    let decoder = tools.getDecoder(null);
    test.ok(decoder);
    test.done();
};

// ============================================
// AuthenticationFailure tests
// ============================================

module.exports['Tools: AuthenticationFailure error class'] = test => {
    let error = new tools.AuthenticationFailure('Auth failed');
    test.ok(error instanceof Error);
    test.equal(error.authenticationFailed, true);
    test.equal(error.message, 'Auth failed');
    test.done();
};

// ============================================
// enhanceCommandError tests
// ============================================

module.exports['Tools: enhanceCommandError sets serverResponseCode'] = async test => {
    let err = new Error('Command failed');
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
    test.equal(result.serverResponseCode, 'NONEXISTENT');
    test.equal(typeof result.response, 'string');
    test.done();
};

module.exports['Tools: enhanceCommandError with no status code'] = async test => {
    let err = new Error('Command failed');
    err.response = { tag: '*', command: 'NO' };
    let result = await tools.enhanceCommandError(err);
    test.ok(!result.serverResponseCode);
    test.done();
};

module.exports['Tools: enhanceCommandError with null response'] = async test => {
    let err = new Error('Command failed');
    err.response = null;
    let result = await tools.enhanceCommandError(err);
    test.equal(result.response, false);
    test.done();
};

// ============================================
// getDecoder additional tests
// ============================================

module.exports['Tools: getDecoder with eucjp charset'] = test => {
    let decoder = tools.getDecoder('eucjp');
    test.ok(decoder);
    test.equal(decoder.constructor.name, 'JPDecoder');
    test.done();
};

module.exports['Tools: getDecoder with euc-jp (hyphenated) returns JPDecoder'] = test => {
    let decoder = tools.getDecoder('euc-jp');
    test.ok(decoder);
    test.equal(decoder.constructor.name, 'JPDecoder');
    test.done();
};

module.exports['Tools: getDecoder with jis charset'] = test => {
    let decoder = tools.getDecoder('jis');
    test.ok(decoder);
    test.equal(decoder.constructor.name, 'JPDecoder');
    test.done();
};

module.exports['Tools: getDecoder with windows-1252 returns iconv stream'] = test => {
    let decoder = tools.getDecoder('windows-1252');
    test.ok(decoder);
    test.notEqual(decoder.constructor.name, 'JPDecoder');
    test.ok(typeof decoder.write === 'function');
    test.done();
};

module.exports['Tools: getDecoder with no arg defaults to ascii'] = test => {
    let decoder = tools.getDecoder();
    test.ok(decoder);
    test.ok(typeof decoder.write === 'function');
    test.done();
};

// ============================================
// getColorFlags tests
// ============================================

module.exports['Tools: getColorFlags returns non-null for all valid colors'] = test => {
    let colors = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'grey'];
    for (let color of colors) {
        let result = tools.getColorFlags(color);
        test.ok(result, `getColorFlags('${color}') should not be null`);
        test.ok(Array.isArray(result.add), `${color} should have add array`);
        test.ok(Array.isArray(result.remove), `${color} should have remove array`);
    }
    test.done();
};

module.exports['Tools: getColorFlags red has Flagged but no MailFlagBit set'] = test => {
    let result = tools.getColorFlags('red');
    // red = index 0, all bits 0 — adds \\Flagged, removes all MailFlagBit flags
    test.ok(result.add.includes('\\Flagged'));
    test.ok(result.remove.includes('$MailFlagBit0'));
    test.ok(result.remove.includes('$MailFlagBit1'));
    test.ok(result.remove.includes('$MailFlagBit2'));
    test.done();
};

module.exports['Tools: getColorFlags orange has MailFlagBit0 set'] = test => {
    let result = tools.getColorFlags('orange');
    // orange = index 1, bit 0 set
    test.ok(result.add.includes('\\Flagged'));
    test.ok(result.add.includes('$MailFlagBit0'));
    test.ok(result.remove.includes('$MailFlagBit1'));
    test.ok(result.remove.includes('$MailFlagBit2'));
    test.done();
};

module.exports['Tools: getColorFlags yellow has MailFlagBit1 set'] = test => {
    let result = tools.getColorFlags('yellow');
    // yellow = index 2, bit 1 set
    test.ok(result.add.includes('\\Flagged'));
    test.ok(result.add.includes('$MailFlagBit1'));
    test.ok(result.remove.includes('$MailFlagBit0'));
    test.ok(result.remove.includes('$MailFlagBit2'));
    test.done();
};

module.exports['Tools: getColorFlags returns null for invalid color'] = test => {
    test.equal(tools.getColorFlags('invalid'), null);
    test.equal(tools.getColorFlags('pink'), null);
    test.done();
};

module.exports['Tools: getColorFlags with null returns result not null'] = test => {
    // null input: colorCode becomes null, which is not < 0, so it falls through
    let result = tools.getColorFlags(null);
    test.ok(result);
    test.ok(result.remove.includes('\\Flagged'));
    test.done();
};

// ============================================
// formatMessageResponse: OBJECTID NIL handling (RFC 8474)
// ============================================

module.exports['Tools: formatMessageResponse handles THREADID NIL'] = async test => {
    // RFC 8474 allows `THREADID NIL` when the server has no thread relation to
    // report (e.g. Strato). The NIL token is parsed as null and must not crash.
    let untagged = await parser('* 1 FETCH (UID 1 EMAILID (E1) THREADID NIL FLAGS (\\Seen) MODSEQ (4312))');
    let result = await tools.formatMessageResponse(untagged, {});
    test.equal(result.seq, 1);
    test.equal(result.uid, 1);
    test.equal(result.emailId, 'E1');
    test.equal(result.threadId, undefined);
    test.ok(result.flags.has('\\Seen'));
    test.equal(result.modseq, 4312n);
    test.done();
};

module.exports['Tools: formatMessageResponse handles normal THREADID'] = async test => {
    let untagged = await parser('* 2 FETCH (THREADID (T9999) EMAILID (E2))');
    let result = await tools.formatMessageResponse(untagged, {});
    test.equal(result.threadId, 'T9999');
    test.equal(result.emailId, 'E2');
    test.done();
};

// ============================================
// formatMessageResponse: non-ASCII mailbox path normalization for stable id
// ============================================

module.exports['Tools: formatMessageResponse normalizes non-ASCII mailbox path for id'] = async test => {
    // No EMAILID, so the message id falls back to an md5 over [path, uidValidity, uid].
    // The mailbox path is non-ASCII and must be modified-UTF-7 normalized before hashing.
    // (A previous bogus regex /[0x80-0xff]/ never matched non-ASCII, skipping normalization.)
    let untagged = await parser('* 1 FETCH (UID 5 FLAGS (\\Seen))');
    let mailbox = { path: '日本語', uidValidity: 123n };
    let result = await tools.formatMessageResponse(untagged, mailbox);

    let encodedPath = iconv.encode('日本語', 'utf-7-imap').toString();
    let expectedId = crypto.createHash('md5').update([encodedPath, '123', '5'].join(':')).digest('hex');
    let rawId = crypto.createHash('md5').update(['日本語', '123', '5'].join(':')).digest('hex');

    test.equal(result.id, expectedId, 'id must hash the UTF-7 normalized path');
    test.notEqual(result.id, rawId, 'id must not hash the raw non-ASCII path');
    test.done();
};

module.exports['Tools: formatMessageResponse parses the full attribute set'] = async test => {
    let untagged = await parser(
        '* 3 FETCH (UID 100 RFC822.SIZE 5000 FLAGS (\\Seen \\Flagged) MODSEQ (12345) ' +
            'X-GM-MSGID 999 X-GM-THRID 888 X-GM-LABELS (\\Important Work) ' +
            'INTERNALDATE "12-Jan-2020 10:00:00 +0000" BODY[1] {3}\r\n BODY[HEADER] {2}\r\n)',
        { literals: [Buffer.from('abc'), Buffer.from('hi')] }
    );
    let mailbox = { path: 'INBOX', uidValidity: 1n }; // no uidNext/highestModseq -> exercise the bump branches
    let r = await tools.formatMessageResponse(untagged, mailbox);
    test.equal(r.uid, 100);
    test.equal(r.size, 5000);
    test.ok(r.flags.has('\\Seen'));
    test.equal(r.modseq, 12345n);
    test.equal(r.emailId, '999'); // X-GM-MSGID
    test.equal(r.threadId, '888'); // X-GM-THRID
    test.ok(r.labels.has('Work'));
    test.ok(r.internalDate instanceof Date);
    test.ok(Buffer.isBuffer(r.headers));
    test.ok(r.bodyParts.get('1'));
    // mailbox estimates bumped from the FETCH data
    test.equal(mailbox.uidNext, 101);
    test.equal(mailbox.highestModseq, 12345n);
    test.done();
};

module.exports['Tools: formatMessageResponse parses envelope and bodystructure'] = async test => {
    let untagged = await parser(
        '* 1 FETCH (ENVELOPE ("Mon, 2 Sep 2013 05:30:13 -0700" "Subject" ((NIL NIL "a" "b.com")) NIL NIL NIL NIL NIL NIL "<id@x>") ' +
            'BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" 12 0 NIL NIL NIL))'
    );
    let r = await tools.formatMessageResponse(untagged, { path: 'INBOX' });
    test.ok(r.envelope);
    test.equal(r.envelope.subject, 'Subject');
    test.ok(r.bodyStructure);
    test.equal(r.bodyStructure.type, 'text/plain');
    test.done();
};

module.exports['Tools: formatMessageResponse source from BODY[] and BINARY[] literals'] = async test => {
    let untagged = await parser('* 1 FETCH (BODY[] {5}\r\n)', { literals: [Buffer.from('HELLO')] });
    let r = await tools.formatMessageResponse(untagged, { path: 'INBOX' });
    test.ok(Buffer.isBuffer(r.source));
    test.equal(r.source.toString(), 'HELLO');
    test.done();
};

module.exports['Tools: formatMessageResponse keeps invalid INTERNALDATE as raw string'] = async test => {
    let untagged = await parser('* 1 FETCH (INTERNALDATE "not a date")');
    let r = await tools.formatMessageResponse(untagged, { path: 'INBOX' });
    test.equal(r.internalDate, 'not a date');
    test.done();
};

module.exports['Tools: parseEnvelope parses every field'] = async test => {
    let untagged = await parser(
        '* 1 FETCH (ENVELOPE ("Mon, 2 Sep 2013 05:30:13 -0700" "Hello" ' +
            '((NIL NIL "from" "x.com")) ((NIL NIL "sender" "x.com")) ((NIL NIL "reply" "x.com")) ' +
            '((NIL NIL "to" "x.com")) ((NIL NIL "cc" "x.com")) ((NIL NIL "bcc" "x.com")) ' +
            '"<inreplyto@x>" "<msgid@x>"))'
    );
    let env = tools.parseEnvelope(untagged.attributes[1][1]);
    test.ok(env.date instanceof Date);
    test.equal(env.subject, 'Hello');
    test.equal(env.from[0].address, 'from@x.com');
    test.equal(env.sender[0].address, 'sender@x.com');
    test.equal(env.replyTo[0].address, 'reply@x.com');
    test.equal(env.to[0].address, 'to@x.com');
    test.equal(env.cc[0].address, 'cc@x.com');
    test.equal(env.bcc[0].address, 'bcc@x.com');
    test.equal(env.inReplyTo, '<inreplyto@x>');
    test.equal(env.messageId, '<msgid@x>');
    test.done();
};

module.exports['Tools: parseEnvelope keeps invalid date as string'] = async test => {
    let untagged = await parser('* 1 FETCH (ENVELOPE ("not a date" "Subj" NIL NIL NIL NIL NIL NIL NIL NIL))');
    let env = tools.parseEnvelope(untagged.attributes[1][1]);
    test.equal(env.date, 'not a date');
    test.done();
};

module.exports['Tools: parseBodystructure parses all single-part extension fields'] = async test => {
    let bs =
        '("TEXT" "PLAIN" ("CHARSET" "utf-8") "<cid@x>" "a description" "BASE64" 100 5 ' +
        '"d41d8cd9" ("attachment" ("filename" "f.txt")) ("en" "de") "http://loc/")';
    let untagged = await parser('* 1 FETCH (BODYSTRUCTURE ' + bs + ')');
    let node = tools.parseBodystructure(untagged.attributes[1][1]);
    test.equal(node.type, 'text/plain');
    test.equal(node.id, '<cid@x>');
    test.equal(node.description, 'a description');
    test.equal(node.encoding, 'base64');
    test.equal(node.size, 100);
    test.equal(node.lineCount, 5);
    test.equal(node.md5, 'd41d8cd9');
    test.equal(node.disposition, 'attachment');
    test.equal(node.dispositionParameters.filename, 'f.txt');
    test.deepEqual(node.language, ['en', 'de']);
    test.done();
};

module.exports['Tools: parseBodystructure parses message/rfc822 with envelope and child'] = async test => {
    let bs =
        '("MESSAGE" "RFC822" NIL NIL NIL "7BIT" 200 ' +
        '("date" "subj" NIL NIL NIL NIL NIL NIL "<reply>" "<msgid>") ' +
        '("TEXT" "PLAIN" NIL NIL NIL "7BIT" 10 1) 3)';
    let untagged = await parser('* 1 FETCH (BODYSTRUCTURE ' + bs + ')');
    let node = tools.parseBodystructure(untagged.attributes[1][1]);
    test.equal(node.type, 'message/rfc822');
    test.ok(node.envelope);
    test.equal(node.childNodes.length, 1);
    test.equal(node.lineCount, 3);
    test.done();
};

module.exports['Tools: parseBodystructure parses multipart with params and disposition'] = async test => {
    let bs =
        '(("TEXT" "PLAIN" NIL NIL NIL "7BIT" 10 1)("TEXT" "HTML" NIL NIL NIL "7BIT" 20 2) ' +
        '"ALTERNATIVE" ("BOUNDARY" "xyz") ("inline" NIL) ("en"))';
    let untagged = await parser('* 1 FETCH (BODYSTRUCTURE ' + bs + ')');
    let node = tools.parseBodystructure(untagged.attributes[1][1]);
    test.equal(node.type, 'multipart/alternative');
    test.equal(node.childNodes.length, 2);
    test.equal(node.parameters.boundary, 'xyz');
    test.equal(node.disposition, 'inline');
    test.done();
};

module.exports['Tools: formatMessageResponse handles NIL, Buffer and unknown keys'] = async test => {
    let untagged = await parser('* 1 FETCH (UID NIL RFC822.SIZE NIL X-GM-MSGID {3}\r\n BODY[] NIL FOOBAR 123)', {
        literals: [Buffer.from('999')]
    });
    let r = await tools.formatMessageResponse(untagged, { path: 'INBOX' });
    test.equal(r.uid, 0); // NIL value -> getString returns false -> Number(false) = 0
    test.equal(r.size, 0);
    test.equal(r.emailId, '999'); // Buffer literal value -> getString stringifies it
    test.equal(r.source, false); // BODY[] NIL -> getBuffer returns false
    test.done();
};

module.exports['Tools: getFolderTree merges duplicate folder entries'] = test => {
    let tree = tools.getFolderTree([
        { name: 'Parent', path: 'Parent', parent: [], flags: new Set(['\\HasChildren']), delimiter: '/' },
        { name: 'Parent', path: 'Parent', parent: [], flags: new Set(['\\Noselect', '\\HasChildren']), specialUse: '\\Sent', delimiter: '/' }
    ]);
    test.equal(tree.folders.length, 1);
    test.equal(tree.folders[0].disabled, true);
    test.equal(tree.folders[0].specialUse, '\\Sent');
    test.done();
};

module.exports['Tools: parseBodystructure handles minimal NIL fields'] = async test => {
    let untagged = await parser('* 1 FETCH (BODYSTRUCTURE ("APPLICATION" "OCTET-STREAM" NIL NIL NIL NIL NIL))');
    let node = tools.parseBodystructure(untagged.attributes[1][1]);
    test.equal(node.type, 'application/octet-stream');
    test.equal(node.id, undefined);
    test.equal(node.encoding, undefined);
    test.done();
};

module.exports['Tools: parseBodystructure decodes RFC 2231 charset continuation params'] = async test => {
    let bs = "(\"TEXT\" \"PLAIN\" (\"name*0*\" \"utf-8''%E2%82%AC abc\" \"name*1\" \"def\") NIL NIL \"7BIT\" 10 1)";
    let untagged = await parser('* 1 FETCH (BODYSTRUCTURE ' + bs + ')');
    let node = tools.parseBodystructure(untagged.attributes[1][1]);
    test.equal(node.parameters.name, '€ abcdef');
    test.done();
};

module.exports['Tools: parseBodystructure handles empty-string extension fields'] = async test => {
    // Empty-string values exercise the `|| ''` / `|| 0` fallbacks in each field.
    let bs = '("TEXT" "PLAIN" ("CHARSET" "") "" "" "" 0 0 "" ("" ("" "")) ("") "")';
    let untagged = await parser('* 1 FETCH (BODYSTRUCTURE ' + bs + ')');
    let node = tools.parseBodystructure(untagged.attributes[1][1]);
    test.equal(node.id, '');
    test.equal(node.description, '');
    test.equal(node.size, 0);
    test.equal(node.md5, '');
    test.deepEqual(node.language, ['']);
    test.done();
};

module.exports['Tools: formatMessageResponse with no data list returns just seq'] = async test => {
    let untagged = await parser('* 5 FETCH');
    let r = await tools.formatMessageResponse(untagged, { path: 'INBOX' });
    test.equal(r.seq, 5);
    test.done();
};

module.exports['Tools: getFolderTree adds folders array when existing entry gains HasChildren'] = test => {
    let tree = tools.getFolderTree([
        { name: 'P', path: 'P', parent: [], flags: new Set([]), delimiter: '/' },
        { name: 'P', path: 'P', parent: [], flags: new Set(['\\HasChildren']), delimiter: '/' }
    ]);
    test.ok(Array.isArray(tree.folders[0].folders), 'folders array created on merge');
    test.done();
};

module.exports['Tools: normalizePath joins array with empty delimiter fallback'] = test => {
    // namespace present but without a delimiter -> the (... || '') fallback joins directly
    let connection = { namespace: { prefix: '' } };
    test.equal(tools.normalizePath(connection, ['a', 'b']), 'ab');
    test.done();
};

module.exports['Tools: updateCapabilities defaults non-numeric APPENDLIMIT to 0'] = test => {
    let caps = tools.updateCapabilities([{ value: 'APPENDLIMIT=abc' }]);
    test.equal(caps.get('APPENDLIMIT'), 0);
    test.done();
};

module.exports['Tools: formatMessageResponse skips non-string label entries'] = async test => {
    let untagged = await parser('* 1 FETCH (X-GM-LABELS (\\Important NIL))');
    let r = await tools.formatMessageResponse(untagged, { path: 'INBOX' });
    test.deepEqual([...r.labels], ['\\Important']); // NIL entry filtered out
    test.done();
};

module.exports['Tools: formatMessageResponse does not lower highestModseq'] = async test => {
    let mailbox = { path: 'INBOX', highestModseq: 99999n };
    let untagged = await parser('* 1 FETCH (MODSEQ (5) FLAGS (\\Seen))');
    await tools.formatMessageResponse(untagged, mailbox);
    test.equal(mailbox.highestModseq, 99999n); // unchanged: incoming modseq is lower
    test.done();
};

module.exports['Tools: parseBodystructure multipart with NIL subtype'] = async test => {
    let untagged = await parser('* 1 FETCH (BODYSTRUCTURE (("TEXT" "PLAIN" NIL NIL NIL "7BIT" 1 1) NIL))');
    let node = tools.parseBodystructure(untagged.attributes[1][1]);
    test.equal(node.type, 'multipart/');
    test.done();
};

module.exports['Tools: parseBodystructure content type with NIL type/subtype'] = async test => {
    let untagged = await parser('* 1 FETCH (BODYSTRUCTURE (NIL NIL NIL NIL NIL "7BIT" 1))');
    let node = tools.parseBodystructure(untagged.attributes[1][1]);
    test.equal(node.type, '/');
    test.done();
};

module.exports['Tools: parseBodystructure message/rfc822 with NIL envelope/linecount'] = async test => {
    let bs = '("MESSAGE" "RFC822" NIL NIL NIL "7BIT" 100 NIL ("TEXT" "PLAIN" NIL NIL NIL "7BIT" 1 1) NIL NIL (NIL) NIL)';
    let untagged = await parser('* 1 FETCH (BODYSTRUCTURE ' + bs + ')');
    let node = tools.parseBodystructure(untagged.attributes[1][1]);
    test.equal(node.type, 'message/rfc822');
    test.done();
};

module.exports['Tools: parseBodystructure text with NIL language/location entries'] = async test => {
    let bs = '("TEXT" "PLAIN" NIL NIL NIL "7BIT" 100 NIL "md5" ("inline" NIL) (NIL) NIL)';
    let untagged = await parser('* 1 FETCH (BODYSTRUCTURE ' + bs + ')');
    let node = tools.parseBodystructure(untagged.attributes[1][1]);
    test.deepEqual(node.language, ['']);
    test.done();
};

module.exports['Tools: parseBodystructure empty-string size/linecount/language/location'] = async test => {
    let bs = '("TEXT" "PLAIN" NIL NIL NIL "7BIT" "" "" "" ("inline" NIL) ("") "")';
    let untagged = await parser('* 1 FETCH (BODYSTRUCTURE ' + bs + ')');
    let node = tools.parseBodystructure(untagged.attributes[1][1]);
    test.equal(node.size, 0);
    test.equal(node.lineCount, 0);
    test.deepEqual(node.language, ['']);
    test.done();
};

module.exports['Tools: parseBodystructure message/rfc822 empty-string linecount'] = async test => {
    let bs =
        '("MESSAGE" "RFC822" NIL NIL NIL "7BIT" 100 ("d" "s" NIL NIL NIL NIL NIL NIL NIL NIL) ' +
        '("TEXT" "PLAIN" NIL NIL NIL "7BIT" 1 1) "")';
    let untagged = await parser('* 1 FETCH (BODYSTRUCTURE ' + bs + ')');
    let node = tools.parseBodystructure(untagged.attributes[1][1]);
    test.equal(node.type, 'message/rfc822');
    test.equal(node.lineCount, 0);
    test.done();
};

module.exports['Tools: parseBodystructure decodes RFC 2231 with empty charset and special chars'] = async test => {
    // Empty charset before the first quote defaults to utf-8; '=' / '?' in the value
    // exercise the 2-char hex escape branch; the empty *1* continuation segment too.
    // value includes '=' / '?' (2-char hex escapes), a space (-> '_') and a TAB
    // (a <0x10 control char -> single-hex-digit escape needing a '0' pad).
    let bs = "(\"TEXT\" \"PLAIN\" (\"name*0*\" \"''a=b?c d\te\" \"name*1*\" \"\") NIL NIL \"7BIT\" 1 1)";
    let untagged = await parser('* 1 FETCH (BODYSTRUCTURE ' + bs + ')');
    let node = tools.parseBodystructure(untagged.attributes[1][1]);
    test.ok(node.parameters.name.includes('a=b?c'));
    test.done();
};

module.exports['Tools: parseBodystructure parses empty-string body location'] = async test => {
    // A trailing element after location makes the (i < length-1) guard pass so the
    // empty-string location value goes through the `|| ''` fallback.
    let bs = '("TEXT" "PLAIN" NIL NIL NIL "7BIT" 1 1 NIL NIL NIL "" NIL)';
    let untagged = await parser('* 1 FETCH (BODYSTRUCTURE ' + bs + ')');
    let node = tools.parseBodystructure(untagged.attributes[1][1]);
    test.equal(node.location, '');
    test.done();
};

module.exports['Tools: expandRange descending range to non-numeric second bound'] = test => {
    test.deepEqual(tools.expandRange('5:abc'), [5, 4, 3, 2, 1, 0]);
    test.done();
};

module.exports['Tools: expandRange tolerates non-numeric entries'] = test => {
    test.deepEqual(tools.expandRange('abc,:5,1:3'), [0, 0, 1, 2, 3, 4, 5, 1, 2, 3]);
    test.done();
};

module.exports['Tools: expandRange handles descending ranges'] = test => {
    test.deepEqual(tools.expandRange('5:3'), [5, 4, 3]);
    test.done();
};

module.exports['Tools: encodePath keeps name as-is when iconv encode throws'] = test => {
    // The iconv module object is shared by reference; patch encode to throw so the
    // defensive catch is exercised, then restore.
    let original = iconv.encode;
    iconv.encode = () => {
        throw new Error('encode boom');
    };
    try {
        let connection = { enabled: new Set() };
        let result = tools.encodePath(connection, 'Tärä');
        test.equal(result, 'Tärä', 'falls back to the raw path');
    } finally {
        iconv.encode = original;
    }
    test.done();
};

module.exports['Tools: decodePath keeps name as-is when iconv decode throws'] = test => {
    let original = iconv.decode;
    iconv.decode = () => {
        throw new Error('decode boom');
    };
    try {
        let connection = { enabled: new Set() };
        let result = tools.decodePath(connection, 'Inbox&AOk-');
        test.equal(result, 'Inbox&AOk-');
    } finally {
        iconv.decode = original;
    }
    test.done();
};

module.exports['Tools: formatMessageResponse id falls back when iconv encode throws'] = async test => {
    let original = iconv.encode;
    iconv.encode = () => {
        throw new Error('encode boom');
    };
    try {
        let untagged = await parser('* 1 FETCH (UID 5 FLAGS (\\Seen))');
        // non-ASCII path triggers the encode branch; the throw is swallowed
        let r = await tools.formatMessageResponse(untagged, { path: 'Tärä', uidValidity: 1n });
        test.ok(r.id, 'an id is still produced');
    } finally {
        iconv.encode = original;
    }
    test.done();
};

// ============================================
// packMessageRange
// ============================================

module.exports['Tools: packMessageRange packs contiguous and gapped ranges'] = test => {
    test.equal(tools.packMessageRange([1, 2, 3, 5, 7, 8]), '1:3,5,7:8');
    test.equal(tools.packMessageRange(7), '7');
    test.equal(tools.packMessageRange([]), '');
    test.done();
};

module.exports['Tools: packMessageRange dedupes duplicate values'] = test => {
    // Duplicates must not produce overlapping/non-canonical tokens like "1,1:3".
    test.equal(tools.packMessageRange([1, 1, 2, 3]), '1:3');
    test.equal(tools.packMessageRange([3, 1, 2, 2, 5]), '1:3,5');
    test.equal(tools.packMessageRange([5, 5, 5]), '5');
    test.done();
};
