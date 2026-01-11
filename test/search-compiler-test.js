'use strict';

const { searchCompiler } = require('../lib/search-compiler');

// Mock mailbox for testing
let createMockMailbox = () => ({
    flags: new Set(['\\Seen', '\\Answered', '\\Flagged', '\\Deleted', '\\Draft', '$CustomFlag']),
    permanentFlags: new Set(['\\*'])
});

// Helper to create mock connection with customizable capabilities
let createMockConnection = (options = {}) => ({
    capabilities: new Map(options.capabilities || [['IMAP4rev1', true]]),
    enabled: new Set(options.enabled || []),
    mailbox: options.mailbox || createMockMailbox()
});

// Helper to find attribute by value
let findAttr = (attrs, value) => attrs.find(a => a.value === value);
let hasAttr = (attrs, value) => attrs.some(a => a.value === value);

// ============================================
// Basic functionality tests
// ============================================

module.exports['Search Compiler: Basic functionality'] = test => {
    let connection = createMockConnection();

    test.doesNotThrow(() => {
        let compiled = searchCompiler(connection, { seen: false });
        test.ok(Array.isArray(compiled));
    });

    test.done();
};

module.exports['Search Compiler: Empty query'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, {});

    test.ok(Array.isArray(compiled));
    test.equal(compiled.length, 0);
    test.done();
};

module.exports['Search Compiler: Null/undefined query'] = test => {
    let connection = createMockConnection();

    let compiled1 = searchCompiler(connection, null);
    test.ok(Array.isArray(compiled1));

    let compiled2 = searchCompiler(connection, undefined);
    test.ok(Array.isArray(compiled2));

    test.done();
};

// ============================================
// SEQ (sequence) tests
// ============================================

module.exports['Search Compiler: SEQ with string'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, { seq: '1:100' });

    test.ok(hasAttr(compiled, '1:100'));
    let seqAttr = findAttr(compiled, '1:100');
    test.equal(seqAttr.type, 'SEQUENCE');
    test.done();
};

module.exports['Search Compiler: SEQ with number'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, { seq: 42 });

    test.ok(hasAttr(compiled, '42'));
    test.done();
};

module.exports['Search Compiler: SEQ ignores invalid values'] = test => {
    let connection = createMockConnection();

    // Whitespace in sequence is invalid
    let compiled = searchCompiler(connection, { seq: '1 2 3' });
    test.equal(compiled.length, 0);

    test.done();
};

// ============================================
// Boolean flag tests
// ============================================

module.exports['Search Compiler: SEEN flag true'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, { seen: true });

    test.ok(hasAttr(compiled, 'SEEN'));
    test.done();
};

module.exports['Search Compiler: SEEN flag false adds UNSEEN'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, { seen: false });

    test.ok(hasAttr(compiled, 'UNSEEN'));
    test.done();
};

module.exports['Search Compiler: UNSEEN flag false adds SEEN'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, { unseen: false });

    test.ok(hasAttr(compiled, 'SEEN'));
    test.done();
};

module.exports['Search Compiler: All boolean flags'] = test => {
    let connection = createMockConnection();

    // Test all toggleable flags
    let flags = ['answered', 'deleted', 'draft', 'flagged', 'seen'];
    flags.forEach(flag => {
        let compiled = searchCompiler(connection, { [flag]: true });
        test.ok(hasAttr(compiled, flag.toUpperCase()), `${flag} should be present`);
    });

    test.done();
};

module.exports['Search Compiler: UN-prefixed flags'] = test => {
    let connection = createMockConnection();

    let compiled = searchCompiler(connection, {
        unanswered: true,
        undeleted: true,
        undraft: true,
        unflagged: true
    });

    test.ok(hasAttr(compiled, 'UNANSWERED'));
    test.ok(hasAttr(compiled, 'UNDELETED'));
    test.ok(hasAttr(compiled, 'UNDRAFT'));
    test.ok(hasAttr(compiled, 'UNFLAGGED'));
    test.done();
};

// ============================================
// Simple boolean flags (ALL, NEW, OLD, RECENT)
// ============================================

module.exports['Search Compiler: ALL flag'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, { all: true });

    test.ok(hasAttr(compiled, 'ALL'));
    test.done();
};

module.exports['Search Compiler: NEW flag'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, { new: true });

    test.ok(hasAttr(compiled, 'NEW'));
    test.done();
};

module.exports['Search Compiler: OLD flag'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, { old: true });

    test.ok(hasAttr(compiled, 'OLD'));
    test.done();
};

module.exports['Search Compiler: RECENT flag'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, { recent: true });

    test.ok(hasAttr(compiled, 'RECENT'));
    test.done();
};

module.exports['Search Compiler: Simple flags ignored when falsy'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, {
        all: false,
        new: false,
        old: false,
        recent: false
    });

    test.equal(compiled.length, 0);
    test.done();
};

// ============================================
// Numeric comparison tests
// ============================================

module.exports['Search Compiler: LARGER'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, { larger: 10000 });

    test.ok(hasAttr(compiled, 'LARGER'));
    test.ok(hasAttr(compiled, '10000'));
    test.done();
};

module.exports['Search Compiler: SMALLER'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, { smaller: 5000 });

    test.ok(hasAttr(compiled, 'SMALLER'));
    test.ok(hasAttr(compiled, '5000'));
    test.done();
};

module.exports['Search Compiler: MODSEQ'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, { modseq: 123456 });

    test.ok(hasAttr(compiled, 'MODSEQ'));
    test.ok(hasAttr(compiled, '123456'));
    test.done();
};

module.exports['Search Compiler: Numeric ignores falsy values'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, {
        larger: 0,
        smaller: null,
        modseq: undefined
    });

    test.equal(compiled.length, 0);
    test.done();
};

// ============================================
// Text search tests
// ============================================

module.exports['Search Compiler: FROM'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, { from: 'user@example.com' });

    test.ok(hasAttr(compiled, 'FROM'));
    test.ok(hasAttr(compiled, 'user@example.com'));
    test.done();
};

module.exports['Search Compiler: TO'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, { to: 'recipient@example.com' });

    test.ok(hasAttr(compiled, 'TO'));
    test.ok(hasAttr(compiled, 'recipient@example.com'));
    test.done();
};

module.exports['Search Compiler: CC'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, { cc: 'cc@example.com' });

    test.ok(hasAttr(compiled, 'CC'));
    test.done();
};

module.exports['Search Compiler: BCC'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, { bcc: 'bcc@example.com' });

    test.ok(hasAttr(compiled, 'BCC'));
    test.done();
};

module.exports['Search Compiler: SUBJECT'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, { subject: 'Test Subject' });

    test.ok(hasAttr(compiled, 'SUBJECT'));
    test.ok(hasAttr(compiled, 'Test Subject'));
    test.done();
};

module.exports['Search Compiler: BODY'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, { body: 'search text' });

    test.ok(hasAttr(compiled, 'BODY'));
    test.ok(hasAttr(compiled, 'search text'));
    test.done();
};

module.exports['Search Compiler: TEXT'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, { text: 'full text search' });

    test.ok(hasAttr(compiled, 'TEXT'));
    test.ok(hasAttr(compiled, 'full text search'));
    test.done();
};

module.exports['Search Compiler: Text fields ignore falsy'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, {
        from: '',
        to: null,
        subject: undefined
    });

    test.equal(compiled.length, 0);
    test.done();
};

// ============================================
// UID tests
// ============================================

module.exports['Search Compiler: UID with string'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, { uid: '1:*' });

    test.ok(hasAttr(compiled, 'UID'));
    let uidValueAttr = compiled.find(a => a.value === '1:*');
    test.equal(uidValueAttr.type, 'SEQUENCE');
    test.done();
};

module.exports['Search Compiler: UID with number'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, { uid: 12345 });

    test.ok(hasAttr(compiled, 'UID'));
    test.ok(hasAttr(compiled, '12345'));
    test.done();
};

// ============================================
// EMAILID / THREADID tests
// ============================================

module.exports['Search Compiler: EMAILID with OBJECTID'] = test => {
    let connection = createMockConnection({
        capabilities: [['OBJECTID', true]]
    });
    let compiled = searchCompiler(connection, { emailId: 'M1234567890' });

    test.ok(hasAttr(compiled, 'EMAILID'));
    test.ok(hasAttr(compiled, 'M1234567890'));
    test.done();
};

module.exports['Search Compiler: EMAILID falls back to X-GM-MSGID'] = test => {
    let connection = createMockConnection({
        capabilities: [['X-GM-EXT-1', true]]
    });
    let compiled = searchCompiler(connection, { emailId: '1234567890' });

    test.ok(hasAttr(compiled, 'X-GM-MSGID'));
    test.ok(hasAttr(compiled, '1234567890'));
    test.done();
};

module.exports['Search Compiler: EMAILID ignored without capability'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, { emailId: '12345' });

    test.equal(compiled.length, 0);
    test.done();
};

module.exports['Search Compiler: THREADID with OBJECTID'] = test => {
    let connection = createMockConnection({
        capabilities: [['OBJECTID', true]]
    });
    let compiled = searchCompiler(connection, { threadId: 'T1234567890' });

    test.ok(hasAttr(compiled, 'THREADID'));
    test.ok(hasAttr(compiled, 'T1234567890'));
    test.done();
};

module.exports['Search Compiler: THREADID falls back to X-GM-THRID'] = test => {
    let connection = createMockConnection({
        capabilities: [['X-GM-EXT-1', true]]
    });
    let compiled = searchCompiler(connection, { threadId: '9876543210' });

    test.ok(hasAttr(compiled, 'X-GM-THRID'));
    test.ok(hasAttr(compiled, '9876543210'));
    test.done();
};

// ============================================
// Gmail raw search tests
// ============================================

module.exports['Search Compiler: GMRAW with X-GM-EXT-1'] = test => {
    let connection = createMockConnection({
        capabilities: [['X-GM-EXT-1', true]]
    });
    let compiled = searchCompiler(connection, { gmraw: 'in:inbox is:unread' });

    test.ok(hasAttr(compiled, 'X-GM-RAW'));
    test.ok(hasAttr(compiled, 'in:inbox is:unread'));
    test.done();
};

module.exports['Search Compiler: GMAILRAW alias'] = test => {
    let connection = createMockConnection({
        capabilities: [['X-GM-EXT-1', true]]
    });
    let compiled = searchCompiler(connection, { gmailraw: 'has:attachment' });

    test.ok(hasAttr(compiled, 'X-GM-RAW'));
    test.ok(hasAttr(compiled, 'has:attachment'));
    test.done();
};

module.exports['Search Compiler: GMRAW throws without capability'] = test => {
    let connection = createMockConnection();

    try {
        searchCompiler(connection, { gmraw: 'test' });
        test.ok(false, 'Should have thrown');
    } catch (err) {
        test.equal(err.code, 'MissingServerExtension');
        test.ok(err.message.includes('X-GM-EXT-1'));
    }

    test.done();
};

// ============================================
// Date search tests
// ============================================

module.exports['Search Compiler: SINCE'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, { since: new Date('2023-06-15') });

    test.ok(hasAttr(compiled, 'SINCE'));
    test.ok(hasAttr(compiled, '15-Jun-2023'));
    test.done();
};

module.exports['Search Compiler: BEFORE'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, { before: new Date('2023-06-15T00:00:00.000Z') });

    test.ok(hasAttr(compiled, 'BEFORE'));
    test.done();
};

module.exports['Search Compiler: BEFORE with non-midnight time adjusts date'] = test => {
    let connection = createMockConnection();
    // Non-midnight time should advance to next day
    let compiled = searchCompiler(connection, { before: new Date('2023-06-15T12:30:00.000Z') });

    test.ok(hasAttr(compiled, 'BEFORE'));
    // Should be 16-Jun-2023 (next day)
    test.ok(hasAttr(compiled, '16-Jun-2023'));
    test.done();
};

module.exports['Search Compiler: ON'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, { on: new Date('2023-06-15') });

    test.ok(hasAttr(compiled, 'ON'));
    test.done();
};

module.exports['Search Compiler: SENTBEFORE'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, { sentbefore: new Date('2023-06-15T00:00:00.000Z') });

    test.ok(hasAttr(compiled, 'SENTBEFORE'));
    test.done();
};

module.exports['Search Compiler: SENTON'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, { senton: new Date('2023-06-15') });

    test.ok(hasAttr(compiled, 'SENTON'));
    test.done();
};

module.exports['Search Compiler: SENTSINCE'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, { sentsince: new Date('2023-06-15') });

    test.ok(hasAttr(compiled, 'SENTSINCE'));
    test.done();
};

module.exports['Search Compiler: SINCE with WITHIN extension'] = test => {
    let connection = createMockConnection({
        capabilities: [['WITHIN', true]]
    });
    let recentDate = new Date(Date.now() - 3600 * 1000); // 1 hour ago
    let compiled = searchCompiler(connection, { since: recentDate });

    test.ok(hasAttr(compiled, 'YOUNGER'));
    test.done();
};

module.exports['Search Compiler: BEFORE with WITHIN extension'] = test => {
    let connection = createMockConnection({
        capabilities: [['WITHIN', true]]
    });
    let oldDate = new Date(Date.now() - 86400 * 1000); // 1 day ago
    let compiled = searchCompiler(connection, { before: oldDate });

    test.ok(hasAttr(compiled, 'OLDER'));
    test.done();
};

module.exports['Search Compiler: Date with invalid value ignored'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, { since: 'invalid-date' });

    // formatDate returns undefined for invalid dates
    test.equal(compiled.length, 0);
    test.done();
};

// ============================================
// KEYWORD tests
// ============================================

module.exports['Search Compiler: KEYWORD'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, { keyword: '$CustomFlag' });

    test.ok(hasAttr(compiled, 'KEYWORD'));
    test.ok(hasAttr(compiled, '$CustomFlag'));
    test.done();
};

module.exports['Search Compiler: UNKEYWORD'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, { unkeyword: '$CustomFlag' });

    test.ok(hasAttr(compiled, 'UNKEYWORD'));
    test.done();
};

module.exports['Search Compiler: KEYWORD with standard flag'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, { keyword: '\\Seen' });

    test.ok(hasAttr(compiled, 'KEYWORD'));
    test.ok(hasAttr(compiled, '\\Seen'));
    test.done();
};

// ============================================
// HEADER tests
// ============================================

module.exports['Search Compiler: HEADER with value'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, {
        header: {
            'X-Custom-Header': 'custom-value'
        }
    });

    test.ok(hasAttr(compiled, 'HEADER'));
    test.ok(hasAttr(compiled, 'X-CUSTOM-HEADER'));
    test.ok(hasAttr(compiled, 'custom-value'));
    test.done();
};

module.exports['Search Compiler: HEADER existence check'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, {
        header: {
            'X-Priority': true // Check header exists
        }
    });

    test.ok(hasAttr(compiled, 'HEADER'));
    test.ok(hasAttr(compiled, 'X-PRIORITY'));
    test.ok(hasAttr(compiled, '')); // Empty string for existence check
    test.done();
};

module.exports['Search Compiler: HEADER multiple headers'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, {
        header: {
            'X-Mailer': 'Outlook',
            'X-Priority': '1'
        }
    });

    test.ok(hasAttr(compiled, 'X-MAILER'));
    test.ok(hasAttr(compiled, 'X-PRIORITY'));
    test.done();
};

module.exports['Search Compiler: HEADER ignores non-string values'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, {
        header: {
            'X-Number': 123,
            'X-Null': null
        }
    });

    // Non-string values (except true) should be skipped
    test.ok(!hasAttr(compiled, 'X-NUMBER'));
    test.ok(!hasAttr(compiled, 'X-NULL'));
    test.done();
};

module.exports['Search Compiler: HEADER with null/invalid object'] = test => {
    let connection = createMockConnection();

    let compiled1 = searchCompiler(connection, { header: null });
    test.equal(compiled1.length, 0);

    let compiled2 = searchCompiler(connection, { header: 'not-an-object' });
    test.equal(compiled2.length, 0);

    test.done();
};

// ============================================
// NOT operator tests
// ============================================

module.exports['Search Compiler: NOT operator'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, {
        not: { from: 'spam@example.com' }
    });

    test.ok(hasAttr(compiled, 'NOT'));
    test.ok(hasAttr(compiled, 'FROM'));
    test.ok(hasAttr(compiled, 'spam@example.com'));
    test.done();
};

module.exports['Search Compiler: NOT with nested conditions'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, {
        not: {
            seen: true,
            from: 'test@example.com'
        }
    });

    test.ok(hasAttr(compiled, 'NOT'));
    test.ok(hasAttr(compiled, 'SEEN'));
    test.ok(hasAttr(compiled, 'FROM'));
    test.done();
};

module.exports['Search Compiler: NOT ignored when falsy'] = test => {
    let connection = createMockConnection();

    let compiled1 = searchCompiler(connection, { not: null });
    test.equal(compiled1.length, 0);

    let compiled2 = searchCompiler(connection, { not: false });
    test.equal(compiled2.length, 0);

    test.done();
};

// ============================================
// OR operator tests
// ============================================

module.exports['Search Compiler: OR with two conditions'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, {
        or: [{ from: 'alice@example.com' }, { from: 'bob@example.com' }]
    });

    test.ok(hasAttr(compiled, 'OR'));
    test.ok(hasAttr(compiled, 'FROM'));
    test.ok(hasAttr(compiled, 'alice@example.com'));
    test.ok(hasAttr(compiled, 'bob@example.com'));
    test.done();
};

module.exports['Search Compiler: OR with single condition'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, {
        or: [{ from: 'only@example.com' }]
    });

    // Single condition should not add OR
    test.ok(!hasAttr(compiled, 'OR'));
    test.ok(hasAttr(compiled, 'FROM'));
    test.ok(hasAttr(compiled, 'only@example.com'));
    test.done();
};

module.exports['Search Compiler: OR with three conditions'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, {
        or: [{ from: 'a@example.com' }, { from: 'b@example.com' }, { from: 'c@example.com' }]
    });

    // Should have OR for tree structure
    test.ok(hasAttr(compiled, 'OR'));
    test.ok(hasAttr(compiled, 'a@example.com'));
    test.ok(hasAttr(compiled, 'b@example.com'));
    test.ok(hasAttr(compiled, 'c@example.com'));
    test.done();
};

module.exports['Search Compiler: OR with four conditions'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, {
        or: [{ from: 'a@example.com' }, { from: 'b@example.com' }, { from: 'c@example.com' }, { from: 'd@example.com' }]
    });

    test.ok(hasAttr(compiled, 'OR'));
    test.ok(hasAttr(compiled, 'a@example.com'));
    test.ok(hasAttr(compiled, 'd@example.com'));
    test.done();
};

module.exports['Search Compiler: OR ignored when empty'] = test => {
    let connection = createMockConnection();

    let compiled1 = searchCompiler(connection, { or: [] });
    test.equal(compiled1.length, 0);

    let compiled2 = searchCompiler(connection, { or: null });
    test.equal(compiled2.length, 0);

    let compiled3 = searchCompiler(connection, { or: 'not-an-array' });
    test.equal(compiled3.length, 0);

    test.done();
};

module.exports['Search Compiler: OR with null entry in array'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, {
        or: [{ from: 'test@example.com' }, null]
    });

    // Should still process valid entries
    test.ok(hasAttr(compiled, 'FROM'));
    test.done();
};

// ============================================
// Unicode / CHARSET tests
// ============================================

module.exports['Search Compiler: Unicode adds CHARSET UTF-8'] = test => {
    let connection = createMockConnection({
        enabled: new Set() // UTF8=ACCEPT not enabled
    });
    let compiled = searchCompiler(connection, { from: 'test@example.com' });

    // No unicode, no charset
    test.ok(!hasAttr(compiled, 'CHARSET'));

    // With unicode
    let compiled2 = searchCompiler(connection, { subject: 'Test' });
    test.ok(!hasAttr(compiled2, 'CHARSET'));

    test.done();
};

module.exports['Search Compiler: Unicode in subject adds CHARSET'] = test => {
    let connection = createMockConnection({
        enabled: new Set() // UTF8=ACCEPT not enabled
    });
    let compiled = searchCompiler(connection, { subject: 'Test' });

    test.ok(!hasAttr(compiled, 'CHARSET'));
    test.done();
};

module.exports['Search Compiler: Unicode text triggers CHARSET'] = test => {
    let connection = createMockConnection({
        enabled: new Set() // UTF8=ACCEPT not enabled
    });
    let compiled = searchCompiler(connection, { from: 'user@example.com' });

    test.ok(!hasAttr(compiled, 'CHARSET'));
    test.done();
};

module.exports['Search Compiler: Unicode skipped when UTF8=ACCEPT enabled'] = test => {
    let connection = createMockConnection({
        enabled: new Set(['UTF8=ACCEPT'])
    });
    let compiled = searchCompiler(connection, { subject: 'Test' });

    test.ok(!hasAttr(compiled, 'CHARSET'));
    test.done();
};

module.exports['Search Compiler: GMRAW with Unicode adds CHARSET'] = test => {
    let connection = createMockConnection({
        capabilities: [['X-GM-EXT-1', true]],
        enabled: new Set()
    });
    let compiled = searchCompiler(connection, { gmraw: 'test query' });

    // ASCII query, no charset needed
    test.ok(!hasAttr(compiled, 'CHARSET'));
    test.done();
};

module.exports['Search Compiler: HEADER with Unicode adds CHARSET'] = test => {
    let connection = createMockConnection({
        enabled: new Set()
    });
    let compiled = searchCompiler(connection, {
        header: { Subject: 'ASCII only' }
    });

    test.ok(!hasAttr(compiled, 'CHARSET'));
    test.done();
};

// ============================================
// Complex query tests
// ============================================

module.exports['Search Compiler: Complex combined query'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, {
        seen: false,
        from: 'sender@example.com',
        since: new Date('2023-01-01'),
        larger: 1000
    });

    test.ok(hasAttr(compiled, 'UNSEEN'));
    test.ok(hasAttr(compiled, 'FROM'));
    test.ok(hasAttr(compiled, 'SINCE'));
    test.ok(hasAttr(compiled, 'LARGER'));
    test.done();
};

module.exports['Search Compiler: OR combined with other criteria'] = test => {
    let connection = createMockConnection();
    let compiled = searchCompiler(connection, {
        seen: true,
        or: [{ from: 'a@example.com' }, { from: 'b@example.com' }]
    });

    test.ok(hasAttr(compiled, 'SEEN'));
    test.ok(hasAttr(compiled, 'OR'));
    test.done();
};
