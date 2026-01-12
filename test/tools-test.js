'use strict';

const tools = require('../lib/tools');

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
    // 'red' is index 0, which is falsy in JS - removes \\Flagged
    let result = tools.getColorFlags('red');
    test.ok(Array.isArray(result.add));
    test.ok(Array.isArray(result.remove));
    test.ok(result.remove.includes('\\Flagged'));
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
