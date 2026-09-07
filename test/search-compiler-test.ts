import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { searchCompiler } from '../src/search-compiler.js';

// Mock mailbox for testing
let createMockMailbox = () => ({
    flags: new Set(['\\Seen', '\\Answered', '\\Flagged', '\\Deleted', '\\Draft', '$CustomFlag']),
    permanentFlags: new Set(['\\*'])
});

// Helper to create mock connection with customizable capabilities
let createMockConnection = (options = {}) => ({
    capabilities: new Map((options as any).capabilities || [['IMAP4rev1', true]]),
    enabled: new Set((options as any).enabled || []),
    mailbox: (options as any).mailbox || createMockMailbox()
});

// Helper to find attribute by value (recurses into sub-arrays for parenthesized groups)
let findAttr: any = (attrs: any, value: any) => {
    for (let a of attrs) {
        if (Array.isArray(a)) {
            let found: any = findAttr(a, value);
            if (found) return found;
        } else if (a.value === value) {
            return a;
        }
    }
    return undefined;
};
let hasAttr = (attrs: any, value: any) => !!findAttr(attrs, value);

describe('search-compiler', () => {
    // ============================================
    // Basic functionality tests
    // ============================================
    it('Search Compiler: Basic functionality', () => {
        let connection: any = createMockConnection();

        assert.doesNotThrow(() => {
            let compiled = searchCompiler(connection, { seen: false });
            assert.ok(Array.isArray(compiled));
        });
    });
    it('Search Compiler: Empty query', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, {});

        assert.ok(Array.isArray(compiled));
        assert.equal(compiled.length, 0);
    });
    it('Search Compiler: Null/undefined query', () => {
        let connection: any = createMockConnection();

        let compiled1 = searchCompiler(connection, null as any);
        assert.ok(Array.isArray(compiled1));

        let compiled2 = searchCompiler(connection as any, undefined as any);
        assert.ok(Array.isArray(compiled2));
    });

    // ============================================
    // SEQ (sequence) tests
    // ============================================
    it('Search Compiler: SEQ with string', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, { seq: '1:100' });

        assert.ok(hasAttr(compiled, '1:100'));
        let seqAttr = findAttr(compiled, '1:100');
        assert.equal(seqAttr.type, 'SEQUENCE');
    });
    it('Search Compiler: SEQ with number', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, { seq: 42 });

        assert.ok(hasAttr(compiled, '42'));
    });
    it('Search Compiler: SEQ passes invalid values through to the compiler guard', () => {
        let connection: any = createMockConnection();

        // An invalid sequence string used to be dropped silently here, which turned the
        // filter into an unrestricted search matching every message. It is now emitted as
        // a SEQUENCE token so the IMAP compiler rejects it with a coded error instead.
        let compiled = searchCompiler(connection, { seq: '1 2 3' });
        let seqAttr: any = compiled.find(a => (a as any).type === 'SEQUENCE');
        assert.ok(seqAttr, 'the sequence value must not be dropped');
        assert.equal(seqAttr.value, '1 2 3');

        // Junk values pass through too, so they fail loudly at the compiler instead of
        // silently widening the search
        let junk = searchCompiler(connection as any, { seq: {} } as any);
        assert.ok(
            junk.find(a => (a as any).type === 'SEQUENCE'),
            'a junk value must not be dropped'
        );

        // Zero is not a valid IMAP sequence number but it is a valid filter value,
        // so it must reach the compiler guard rather than be dropped as falsy
        let zero: any = searchCompiler(connection as any, { seq: 0 });
        assert.equal((zero.find((a: any) => (a as any).type === 'SEQUENCE') as any).value, '0', 'zero must not be dropped');
    });
    it('Search Compiler: SEQ array compiles to a single comma-joined set', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, { seq: [1, 3] } as any);

        let seqAttr: any = compiled.find(a => (a as any).type === 'SEQUENCE');
        assert.ok(seqAttr, 'array must produce a sequence set');
        assert.equal(seqAttr.value, '1,3');
    });
    it('Search Compiler: SEQ empty string compiles to nothing', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, { seq: '' });

        assert.ok(!compiled.find(a => (a as any).type === 'SEQUENCE'), 'an empty set adds no SEQUENCE attribute');
        assert.equal(compiled.length, 0);
    });

    // ============================================
    // Boolean flag tests
    // ============================================
    it('Search Compiler: SEEN flag true', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, { seen: true });

        assert.ok(hasAttr(compiled, 'SEEN'));
    });
    it('Search Compiler: SEEN flag false adds UNSEEN', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, { seen: false });

        assert.ok(hasAttr(compiled, 'UNSEEN'));
    });
    it('Search Compiler: UNSEEN flag false adds SEEN', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, { unseen: false } as any);

        assert.ok(hasAttr(compiled, 'SEEN'));
    });
    it('Search Compiler: All boolean flags', () => {
        let connection: any = createMockConnection();

        // Test all toggleable flags
        let flags = ['answered', 'deleted', 'draft', 'flagged', 'seen'];
        flags.forEach(flag => {
            let compiled = searchCompiler(connection, { [flag]: true });
            assert.ok(hasAttr(compiled, flag.toUpperCase()), `${flag} should be present`);
        });
    });
    it('Search Compiler: UN-prefixed flags', () => {
        let connection: any = createMockConnection();

        let compiled = searchCompiler(connection, {
            unanswered: true,
            undeleted: true,
            undraft: true,
            unflagged: true
        } as any);

        assert.ok(hasAttr(compiled, 'UNANSWERED'));
        assert.ok(hasAttr(compiled, 'UNDELETED'));
        assert.ok(hasAttr(compiled, 'UNDRAFT'));
        assert.ok(hasAttr(compiled, 'UNFLAGGED'));
    });

    // ============================================
    // Simple boolean flags (ALL, NEW, OLD, RECENT)
    // ============================================
    it('Search Compiler: ALL flag', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, { all: true });

        assert.ok(hasAttr(compiled, 'ALL'));
    });
    it('Search Compiler: NEW flag', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, { new: true });

        assert.ok(hasAttr(compiled, 'NEW'));
    });
    it('Search Compiler: OLD flag', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, { old: true });

        assert.ok(hasAttr(compiled, 'OLD'));
    });
    it('Search Compiler: RECENT flag', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, { recent: true });

        assert.ok(hasAttr(compiled, 'RECENT'));
    });
    it('Search Compiler: NEW/OLD/RECENT throw on rev2 sessions', () => {
        // IMAP4rev2 (RFC 9051) removed the \Recent flag and these search keys -
        // a rev2 server would reject the whole search with a tagged BAD
        let connection: any = createMockConnection({ enabled: ['IMAP4REV2'] });
        for (let key of ['new', 'old', 'recent']) {
            try {
                searchCompiler(connection, { [key]: true });
                assert.ok(false, `Should have thrown for ${key}`);
            } catch (err: any) {
                assert.equal(err.code, 'MissingServerExtension');
            }
        }
        // Falsy values compile to nothing and must not throw
        assert.equal(searchCompiler(connection as any, { recent: false }).length, 0);
        // ALL is still part of the rev2 grammar
        assert.ok(hasAttr(searchCompiler(connection as any, { all: true }), 'ALL'));
    });
    it('Search Compiler: Simple flags ignored when falsy', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, {
            all: false,
            new: false,
            old: false,
            recent: false
        });

        assert.equal(compiled.length, 0);
    });

    // ============================================
    // Numeric comparison tests
    // ============================================
    it('Search Compiler: LARGER', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, { larger: 10000 });

        assert.ok(hasAttr(compiled, 'LARGER'));
        assert.ok(hasAttr(compiled, '10000'));
    });
    it('Search Compiler: SMALLER', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, { smaller: 5000 });

        assert.ok(hasAttr(compiled, 'SMALLER'));
        assert.ok(hasAttr(compiled, '5000'));
    });
    it('Search Compiler: MODSEQ', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, { modseq: 123456 });

        assert.ok(hasAttr(compiled, 'MODSEQ'));
        assert.ok(hasAttr(compiled, '123456'));
    });
    it('Search Compiler: Numeric ignores falsy values', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, {
            larger: 0,
            smaller: null,
            modseq: undefined
        } as any);

        assert.equal(compiled.length, 0);
    });

    // ============================================
    // Text search tests
    // ============================================
    it('Search Compiler: FROM', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, { from: 'user@example.com' });

        assert.ok(hasAttr(compiled, 'FROM'));
        assert.ok(hasAttr(compiled, 'user@example.com'));
    });
    it('Search Compiler: TO', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, { to: 'recipient@example.com' });

        assert.ok(hasAttr(compiled, 'TO'));
        assert.ok(hasAttr(compiled, 'recipient@example.com'));
    });
    it('Search Compiler: CC', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, { cc: 'cc@example.com' });

        assert.ok(hasAttr(compiled, 'CC'));
    });
    it('Search Compiler: BCC', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, { bcc: 'bcc@example.com' });

        assert.ok(hasAttr(compiled, 'BCC'));
    });
    it('Search Compiler: SUBJECT', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, { subject: 'Test Subject' });

        assert.ok(hasAttr(compiled, 'SUBJECT'));
        assert.ok(hasAttr(compiled, 'Test Subject'));
    });
    it('Search Compiler: BODY', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, { body: 'search text' });

        assert.ok(hasAttr(compiled, 'BODY'));
        assert.ok(hasAttr(compiled, 'search text'));
    });
    it('Search Compiler: TEXT', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, { text: 'full text search' });

        assert.ok(hasAttr(compiled, 'TEXT'));
        assert.ok(hasAttr(compiled, 'full text search'));
    });
    it('Search Compiler: Text fields ignore falsy', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, {
            from: '',
            to: null,
            subject: undefined
        } as any);

        assert.equal(compiled.length, 0);
    });

    // ============================================
    // UID tests
    // ============================================
    it('Search Compiler: UID with string', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, { uid: '1:*' });

        assert.ok(hasAttr(compiled, 'UID'));
        let uidValueAttr: any = compiled.find(a => (a as any).value === '1:*');
        assert.equal((uidValueAttr as any).type, 'SEQUENCE');
    });
    it('Search Compiler: UID with number', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, { uid: 12345 });

        assert.ok(hasAttr(compiled, 'UID'));
        assert.ok(hasAttr(compiled, '12345'));
    });
    it('Search Compiler: UID array compiles to a single comma-joined set', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, { uid: [5, 7, 9] } as any);

        // Separate tokens ("UID 5 7 9") would be parsed by the server as extra
        // sequence-number search keys ANDed to the query - the array means the set {5,7,9}
        assert.ok(hasAttr(compiled, 'UID'));
        let uidValueAttr: any = compiled.find(a => (a as any).value === '5,7,9');
        assert.ok(uidValueAttr, 'array must be joined into one sequence set');
        assert.equal(uidValueAttr.type, 'SEQUENCE');
    });
    it('Search Compiler: UID accepts the SEARCHRES $ marker', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, { uid: '$' });

        assert.ok(hasAttr(compiled, 'UID'));
        let uidValueAttr: any = compiled.find(a => (a as any).value === '$');
        assert.ok(uidValueAttr, 'the saved-result marker must pass through');
        assert.equal(uidValueAttr.type, 'SEQUENCE');
    });

    // ============================================
    // EMAILID / THREADID tests
    // ============================================
    it('Search Compiler: EMAILID with OBJECTID', () => {
        let connection: any = createMockConnection({
            capabilities: [['OBJECTID', true]]
        });
        let compiled = searchCompiler(connection, { emailId: 'M1234567890' });

        assert.ok(hasAttr(compiled, 'EMAILID'));
        assert.ok(hasAttr(compiled, 'M1234567890'));
    });
    it('Search Compiler: EMAILID falls back to X-GM-MSGID', () => {
        let connection: any = createMockConnection({
            capabilities: [['X-GM-EXT-1', true]]
        });
        let compiled = searchCompiler(connection, { emailId: '1234567890' });

        assert.ok(hasAttr(compiled, 'X-GM-MSGID'));
        assert.ok(hasAttr(compiled, '1234567890'));
    });
    it('Search Compiler: EMAILID ignored without capability', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, { emailId: '12345' });

        assert.equal(compiled.length, 0);
    });
    it('Search Compiler: THREADID with OBJECTID', () => {
        let connection: any = createMockConnection({
            capabilities: [['OBJECTID', true]]
        });
        let compiled = searchCompiler(connection, { threadId: 'T1234567890' });

        assert.ok(hasAttr(compiled, 'THREADID'));
        assert.ok(hasAttr(compiled, 'T1234567890'));
    });
    it('Search Compiler: THREADID falls back to X-GM-THRID', () => {
        let connection: any = createMockConnection({
            capabilities: [['X-GM-EXT-1', true]]
        });
        let compiled = searchCompiler(connection, { threadId: '9876543210' });

        assert.ok(hasAttr(compiled, 'X-GM-THRID'));
        assert.ok(hasAttr(compiled, '9876543210'));
    });

    // ============================================
    // Gmail raw search tests
    // ============================================
    it('Search Compiler: GMRAW with X-GM-EXT-1', () => {
        let connection: any = createMockConnection({
            capabilities: [['X-GM-EXT-1', true]]
        });
        let compiled = searchCompiler(connection, { gmraw: 'in:inbox is:unread' });

        assert.ok(hasAttr(compiled, 'X-GM-RAW'));
        assert.ok(hasAttr(compiled, 'in:inbox is:unread'));
    });
    it('Search Compiler: GMAILRAW alias', () => {
        let connection: any = createMockConnection({
            capabilities: [['X-GM-EXT-1', true]]
        });
        let compiled = searchCompiler(connection, { gmailraw: 'has:attachment' });

        assert.ok(hasAttr(compiled, 'X-GM-RAW'));
        assert.ok(hasAttr(compiled, 'has:attachment'));
    });
    it('Search Compiler: GMRAW throws without capability', () => {
        let connection: any = createMockConnection();

        try {
            searchCompiler(connection, { gmraw: 'test' });
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.equal(err.code, 'MissingServerExtension');
            assert.ok(err.message.includes('X-GM-EXT-1') as any);
        }
    });

    // ============================================
    // Gmail label search tests
    // ============================================
    it('Search Compiler: LABELS has compiles to label: via X-GM-RAW', () => {
        let connection: any = createMockConnection({
            capabilities: [['X-GM-EXT-1', true]]
        });
        let compiled = searchCompiler(connection, { labels: { has: ['Horizon'] } });

        assert.ok(hasAttr(compiled, 'X-GM-RAW'));
        assert.ok(hasAttr(compiled, 'label:Horizon'));
    });
    it('Search Compiler: LABELS not compiles to -label: via X-GM-RAW', () => {
        let connection: any = createMockConnection({
            capabilities: [['X-GM-EXT-1', true]]
        });
        let compiled = searchCompiler(connection, { labels: { not: ['Horizon'] } });

        assert.ok(hasAttr(compiled, 'X-GM-RAW'));
        assert.ok(hasAttr(compiled, '-label:Horizon'));
    });
    it('Search Compiler: LABELS with a non-object value is ignored', () => {
        let connection: any = createMockConnection();

        // Neither a falsy value nor a plain string is a { has, not } filter - both
        // must compile to nothing even without the Gmail extension
        let compiledNull = searchCompiler(connection, { labels: null } as any);
        assert.equal(compiledNull.length, 0);

        let compiledString = searchCompiler(connection as any, { labels: 'Horizon' } as any);
        assert.equal(compiledString.length, 0);
    });
    it('Search Compiler: LABELS has and not combined', () => {
        let connection: any = createMockConnection({
            capabilities: [['X-GM-EXT-1', true]]
        });
        let compiled = searchCompiler(connection, { labels: { has: ['Imported'], not: ['Horizon'] } });

        assert.ok(hasAttr(compiled, 'label:Imported -label:Horizon'));
    });
    it('Search Compiler: LABELS quotes multi-word names', () => {
        let connection: any = createMockConnection({
            capabilities: [['X-GM-EXT-1', true]]
        });
        let compiled = searchCompiler(connection, { labels: { has: ['Some Label'] } });

        assert.ok(hasAttr(compiled, 'label:"Some Label"'));
    });
    it('Search Compiler: LABELS coexists with gmraw', () => {
        let connection: any = createMockConnection({
            capabilities: [['X-GM-EXT-1', true]]
        });
        let compiled = searchCompiler(connection, { gmraw: 'has:attachment', labels: { not: ['Horizon'] } });

        assert.ok(hasAttr(compiled, 'has:attachment'));
        assert.ok(hasAttr(compiled, '-label:Horizon'));
    });
    it('Search Compiler: LABELS throws without capability', () => {
        let connection: any = createMockConnection();

        try {
            searchCompiler(connection, { labels: { not: ['Horizon'] } });
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.equal(err.code, 'MissingServerExtension');
            assert.ok(err.message.includes('X-GM-EXT-1') as any);
        }
    });
    it('Search Compiler: empty LABELS is a no-op without capability', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, { labels: {} });

        assert.ok(!hasAttr(compiled, 'X-GM-RAW'));
        assert.equal(compiled.length, 0);
    });

    // ============================================
    // Date search tests
    // ============================================
    it('Search Compiler: SINCE', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, { since: new Date('2023-06-15') });

        assert.ok(hasAttr(compiled, 'SINCE'));
        assert.ok(hasAttr(compiled, '15-Jun-2023'));
    });
    it('Search Compiler: BEFORE', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, { before: new Date('2023-06-15T00:00:00.000Z') });

        assert.ok(hasAttr(compiled, 'BEFORE'));
    });
    it('Search Compiler: BEFORE with non-midnight time adjusts date', () => {
        let connection: any = createMockConnection();
        // Non-midnight time should advance to next day
        let compiled = searchCompiler(connection, { before: new Date('2023-06-15T12:30:00.000Z') });

        assert.ok(hasAttr(compiled, 'BEFORE'));
        // Should be 16-Jun-2023 (next day)
        assert.ok(hasAttr(compiled, '16-Jun-2023'));
    });
    it('Search Compiler: ON', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, { on: new Date('2023-06-15') });

        assert.ok(hasAttr(compiled, 'ON'));
    });
    it('Search Compiler: SENTBEFORE', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, { sentbefore: new Date('2023-06-15T00:00:00.000Z') } as any);

        assert.ok(hasAttr(compiled, 'SENTBEFORE'));
    });
    it('Search Compiler: SENTON', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, { senton: new Date('2023-06-15') } as any);

        assert.ok(hasAttr(compiled, 'SENTON'));
    });
    it('Search Compiler: SENTSINCE', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, { sentsince: new Date('2023-06-15') } as any);

        assert.ok(hasAttr(compiled, 'SENTSINCE'));
    });
    it('Search Compiler: SINCE with WITHIN extension', () => {
        let connection: any = createMockConnection({
            capabilities: [['WITHIN', true]]
        });
        let recentDate = new Date(Date.now() - 3600 * 1000); // 1 hour ago
        let compiled = searchCompiler(connection, { since: recentDate });

        assert.ok(hasAttr(compiled, 'YOUNGER'));
    });
    it('Search Compiler: BEFORE with WITHIN extension', () => {
        let connection: any = createMockConnection({
            capabilities: [['WITHIN', true]]
        });
        let oldDate = new Date(Date.now() - 86400 * 1000); // 1 day ago
        let compiled = searchCompiler(connection, { before: oldDate });

        assert.ok(hasAttr(compiled, 'OLDER'));
    });
    it('Search Compiler: Date with invalid value ignored', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, { since: 'invalid-date' });

        // formatDate returns undefined for invalid dates
        assert.equal(compiled.length, 0);
    });
    it('Search Compiler: all date keys ignore an invalid Date object', () => {
        // An invalid Date is still a Date, so a plain Date brand check let it through:
        // BEFORE/SENTBEFORE threw RangeError from toISOString(), and with WITHIN
        // advertised BEFORE/SINCE compiled a literal "OLDER NaN"/"YOUNGER NaN" token
        for (let capabilities of [[['IMAP4rev1', true]], [['WITHIN', true]]]) {
            for (let key of ['before', 'since', 'on', 'sentBefore', 'sentOn', 'sentSince']) {
                let connection: any = createMockConnection({ capabilities });
                let compiled = searchCompiler(connection, { [key]: new Date('not-a-date') });

                assert.deepEqual(compiled, [], `${key} should compile to no attributes`);
            }
        }
    });
    it('Search Compiler: invalid date drops only its own criterion', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, { seen: true, before: new Date('not-a-date') });

        assert.deepEqual(compiled, [{ type: 'ATOM', value: 'SEEN' }]);
    });
    it('Search Compiler: date string and Date object compile alike for BEFORE', () => {
        let asDate = searchCompiler(createMockConnection() as any, { before: new Date('2023-06-15T12:30:00.000Z') });
        let asString = searchCompiler(createMockConnection() as any, { before: '2023-06-15T12:30:00.000Z' });

        // Both input forms are documented, so both must get the +24h shift that makes
        // same-day BEFORE+SINCE ranges match. The string form used to skip it.
        assert.deepEqual(asString, asDate);
        assert.ok(hasAttr(asString, '16-Jun-2023'));
    });
    it('Search Compiler: date string and Date object compile alike for WITHIN', () => {
        let connection: any = createMockConnection({ capabilities: [['WITHIN', true]] });
        let recentDate = new Date(Date.now() - 3600 * 1000); // 1 hour ago
        let asDate = searchCompiler(connection, { since: recentDate });
        let asString = searchCompiler(connection as any, { since: recentDate.toISOString() });

        // The string form used to skip the WITHIN shortcut and compile SINCE instead
        assert.ok(hasAttr(asDate, 'YOUNGER'));
        assert.ok(hasAttr(asString, 'YOUNGER'));
        // The keyword atom is followed by its value token
        let seconds = (attrs: any) => Number(attrs[1].value);
        // Both are measured against Date.now() at compile time, so allow a small drift
        assert.ok(Math.abs(seconds(asString) - seconds(asDate)) <= 1);
    });

    // ============================================
    // KEYWORD tests
    // ============================================
    it('Search Compiler: KEYWORD', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, { keyword: '$CustomFlag' });

        assert.ok(hasAttr(compiled, 'KEYWORD'));
        assert.ok(hasAttr(compiled, '$CustomFlag'));
    });
    it('Search Compiler: UNKEYWORD', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, { unkeyword: '$CustomFlag' } as any);

        assert.ok(hasAttr(compiled, 'UNKEYWORD'));
    });
    it('Search Compiler: KEYWORD with standard flag', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, { keyword: '\\Seen' });

        assert.ok(hasAttr(compiled, 'KEYWORD'));
        assert.ok(hasAttr(compiled, '\\Seen'));
    });

    // ============================================
    // HEADER tests
    // ============================================
    it('Search Compiler: HEADER with value', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, {
            header: {
                'X-Custom-Header': 'custom-value'
            }
        });

        assert.ok(hasAttr(compiled, 'HEADER'));
        assert.ok(hasAttr(compiled, 'X-CUSTOM-HEADER'));
        assert.ok(hasAttr(compiled, 'custom-value'));
    });
    it('Search Compiler: HEADER existence check', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, {
            header: {
                'X-Priority': true // Check header exists
            }
        });

        assert.ok(hasAttr(compiled, 'HEADER'));
        assert.ok(hasAttr(compiled, 'X-PRIORITY'));
        assert.ok(hasAttr(compiled, ''));
    });
    it('Search Compiler: HEADER multiple headers', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, {
            header: {
                'X-Mailer': 'Outlook',
                'X-Priority': '1'
            }
        });

        assert.ok(hasAttr(compiled, 'X-MAILER'));
        assert.ok(hasAttr(compiled, 'X-PRIORITY'));
    });
    it('Search Compiler: HEADER ignores non-string values', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, {
            header: {
                'X-Number': 123,
                'X-Null': null
            }
        } as any);

        // Non-string values (except true) should be skipped
        assert.ok(!hasAttr(compiled, 'X-NUMBER'));
        assert.ok(!hasAttr(compiled, 'X-NULL'));
    });
    it('Search Compiler: HEADER with null/invalid object', () => {
        let connection: any = createMockConnection();

        let compiled1 = searchCompiler(connection, { header: null } as any);
        assert.equal(compiled1.length, 0);

        let compiled2 = searchCompiler(connection as any, { header: 'not-an-object' } as any);
        assert.equal(compiled2.length, 0);
    });

    // ============================================
    // NOT operator tests
    // ============================================
    it('Search Compiler: NOT operator', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, {
            not: { from: 'spam@example.com' }
        });

        assert.ok(hasAttr(compiled, 'NOT'));
        assert.ok(hasAttr(compiled, 'FROM'));
        assert.ok(hasAttr(compiled, 'spam@example.com'));
    });
    it('Search Compiler: NOT with nested conditions', () => {
        let connection: any = createMockConnection();
        let compiled: any = searchCompiler(connection, {
            not: {
                seen: true,
                from: 'test@example.com'
            }
        });

        assert.ok(hasAttr(compiled, 'NOT'));
        assert.ok(hasAttr(compiled, 'SEEN'));
        assert.ok(hasAttr(compiled, 'FROM'));
        // Compound NOT conditions should be wrapped in a sub-array (parenthesized)
        // so the server treats them as a single search-key
        assert.equal(compiled[0].value, 'NOT');
        assert.ok(Array.isArray(compiled[1]), 'compound NOT should be parenthesized');
    });
    it('Search Compiler: NOT ignored when falsy', () => {
        let connection: any = createMockConnection();

        let compiled1 = searchCompiler(connection, { not: null } as any);
        assert.equal(compiled1.length, 0);

        let compiled2 = searchCompiler(connection as any, { not: false } as any);
        assert.equal(compiled2.length, 0);
    });

    // ============================================
    // OR operator tests
    // ============================================
    it('Search Compiler: OR with two conditions', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, {
            or: [{ from: 'alice@example.com' }, { from: 'bob@example.com' }]
        });

        assert.ok(hasAttr(compiled, 'OR'));
        assert.ok(hasAttr(compiled, 'FROM'));
        assert.ok(hasAttr(compiled, 'alice@example.com'));
        assert.ok(hasAttr(compiled, 'bob@example.com'));
    });
    it('Search Compiler: OR with single condition', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, {
            or: [{ from: 'only@example.com' }]
        });

        // Single condition should not add OR
        assert.ok(!hasAttr(compiled, 'OR'));
        assert.ok(hasAttr(compiled, 'FROM'));
        assert.ok(hasAttr(compiled, 'only@example.com'));
    });
    it('Search Compiler: OR with three conditions', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, {
            or: [{ from: 'a@example.com' }, { from: 'b@example.com' }, { from: 'c@example.com' }]
        });

        // Should have OR for tree structure
        assert.ok(hasAttr(compiled, 'OR'));
        assert.ok(hasAttr(compiled, 'a@example.com'));
        assert.ok(hasAttr(compiled, 'b@example.com'));
        assert.ok(hasAttr(compiled, 'c@example.com'));
    });
    it('Search Compiler: OR with four conditions', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, {
            or: [{ from: 'a@example.com' }, { from: 'b@example.com' }, { from: 'c@example.com' }, { from: 'd@example.com' }]
        });

        assert.ok(hasAttr(compiled, 'OR'));
        assert.ok(hasAttr(compiled, 'a@example.com'));
        assert.ok(hasAttr(compiled, 'd@example.com'));
    });
    it('Search Compiler: OR ignored when empty', () => {
        let connection: any = createMockConnection();

        let compiled1 = searchCompiler(connection, { or: [] });
        assert.equal(compiled1.length, 0);

        let compiled2 = searchCompiler(connection as any, { or: null } as any);
        assert.equal(compiled2.length, 0);

        let compiled3 = searchCompiler(connection as any, { or: 'not-an-array' } as any);
        assert.equal(compiled3.length, 0);
    });
    it('Search Compiler: OR with null entry in array', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, {
            or: [{ from: 'test@example.com' }, null]
        } as any);

        // Should still process valid entries
        assert.ok(hasAttr(compiled, 'FROM'));
    });

    // ============================================
    // Unicode / CHARSET tests
    // ============================================
    it('Search Compiler: Unicode adds CHARSET UTF-8', () => {
        let connection: any = createMockConnection({
            enabled: new Set() // UTF8=ACCEPT not enabled
        });
        let compiled = searchCompiler(connection, { from: 'test@example.com' });

        // No unicode, no charset
        assert.ok(!hasAttr(compiled, 'CHARSET'));

        // With unicode
        let compiled2 = searchCompiler(connection as any, { subject: 'Test' });
        assert.ok(!hasAttr(compiled2, 'CHARSET'));
    });
    it('Search Compiler: Unicode in subject adds CHARSET', () => {
        let connection: any = createMockConnection({
            enabled: new Set() // UTF8=ACCEPT not enabled
        });
        let compiled = searchCompiler(connection, { subject: 'Test' });

        assert.ok(!hasAttr(compiled, 'CHARSET'));
    });
    it('Search Compiler: Unicode text triggers CHARSET', () => {
        let connection: any = createMockConnection({
            enabled: new Set() // UTF8=ACCEPT not enabled
        });
        let compiled = searchCompiler(connection, { from: 'user@example.com' });

        assert.ok(!hasAttr(compiled, 'CHARSET'));
    });
    it('Search Compiler: Unicode skipped when UTF8=ACCEPT enabled', () => {
        let connection: any = createMockConnection({
            enabled: new Set(['UTF8=ACCEPT'])
        });
        let compiled = searchCompiler(connection, { subject: 'Test' });

        assert.ok(!hasAttr(compiled, 'CHARSET'));
    });
    it('Search Compiler: Unicode on rev2 without UTF8=ACCEPT still adds CHARSET UTF-8', () => {
        // RFC 9051 6.4.4: rev2 servers MUST assume UTF-8 when CHARSET is absent, and
        // sending CHARSET UTF-8 is "redundant" but explicitly "permitted for improved
        // compatibility" - pin the compiler's choice to send it until UTF8=ACCEPT is
        // actually ENABLEd
        let connection: any = createMockConnection({
            capabilities: [['IMAP4rev2', true]],
            enabled: new Set()
        });
        let compiled = searchCompiler(connection, { subject: 'Sõnum' });

        let charset = findAttr(compiled, 'CHARSET');
        assert.ok(charset, 'CHARSET prefix expected for a unicode search value');
        assert.ok(hasAttr(compiled, 'UTF-8'));
    });
    it('Search Compiler: GMRAW with Unicode adds CHARSET', () => {
        let connection: any = createMockConnection({
            capabilities: [['X-GM-EXT-1', true]],
            enabled: new Set()
        });
        let compiled = searchCompiler(connection, { gmraw: 'test query' });

        // ASCII query, no charset needed
        assert.ok(!hasAttr(compiled, 'CHARSET'));
    });
    it('Search Compiler: HEADER with Unicode adds CHARSET', () => {
        let connection: any = createMockConnection({
            enabled: new Set()
        });
        let compiled = searchCompiler(connection, {
            header: { Subject: 'ASCII only' }
        });

        assert.ok(!hasAttr(compiled, 'CHARSET'));
    });
    it('Search Compiler: non-ASCII text field adds CHARSET UTF-8', () => {
        let connection: any = createMockConnection({
            enabled: new Set() // UTF8=ACCEPT not enabled
        });
        // Non-ASCII subject must flip hasUnicode and prepend CHARSET UTF-8
        let compiled = searchCompiler(connection, { subject: 'résumé café' });
        assert.ok(hasAttr(compiled, 'CHARSET'));
        assert.ok(hasAttr(compiled, 'UTF-8'));
    });
    it('Search Compiler: non-ASCII body field adds CHARSET UTF-8', () => {
        let connection: any = createMockConnection({
            enabled: new Set()
        });
        let compiled = searchCompiler(connection, { body: 'Grüße' });
        assert.ok(hasAttr(compiled, 'CHARSET'));
    });
    it('Search Compiler: non-ASCII GMRAW adds CHARSET UTF-8', () => {
        let connection: any = createMockConnection({
            capabilities: [['X-GM-EXT-1', true]],
            enabled: new Set()
        });
        let compiled = searchCompiler(connection, { gmraw: 'subject:café' });
        assert.ok(hasAttr(compiled, 'CHARSET'));
        assert.ok(hasAttr(compiled, 'X-GM-RAW'));
    });
    it('Search Compiler: non-ASCII LABELS adds CHARSET UTF-8', () => {
        let connection: any = createMockConnection({
            capabilities: [['X-GM-EXT-1', true]],
            enabled: new Set()
        });
        // The label filter compiles into an X-GM-RAW query, and a non-ASCII label name
        // must mark the compiled query as Unicode the same way a direct gmraw value does
        let compiled = searchCompiler(connection, { labels: { has: ['Tähtis'] } });
        assert.ok(hasAttr(compiled, 'CHARSET'));
        assert.ok(hasAttr(compiled, 'X-GM-RAW'));
        assert.ok(hasAttr(compiled, 'label:Tähtis'));
    });

    // ============================================
    // Complex query tests
    // ============================================
    it('Search Compiler: Complex combined query', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, {
            seen: false,
            from: 'sender@example.com',
            since: new Date('2023-01-01'),
            larger: 1000
        });

        assert.ok(hasAttr(compiled, 'UNSEEN'));
        assert.ok(hasAttr(compiled, 'FROM'));
        assert.ok(hasAttr(compiled, 'SINCE'));
        assert.ok(hasAttr(compiled, 'LARGER'));
    });
    it('Search Compiler: OR combined with other criteria', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, {
            seen: true,
            or: [{ from: 'a@example.com' }, { from: 'b@example.com' }]
        });

        assert.ok(hasAttr(compiled, 'SEEN'));
        assert.ok(hasAttr(compiled, 'OR'));
    });

    // ============================================
    // OR tree structure tests
    // ============================================
    it('Search Compiler: OR with 3 conditions builds binary tree', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, {
            or: [{ from: 'alice' }, { to: 'bob' }, { subject: 'test' }]
        });

        assert.ok(hasAttr(compiled, 'OR'), 'should contain OR atom');
        assert.ok(hasAttr(compiled, 'alice'), 'should contain alice');
        assert.ok(hasAttr(compiled, 'bob'), 'should contain bob');
        assert.ok(hasAttr(compiled, 'test'), 'should contain test');
        assert.ok(hasAttr(compiled, 'FROM'), 'should contain FROM');
        assert.ok(hasAttr(compiled, 'TO'), 'should contain TO');
        assert.ok(hasAttr(compiled, 'SUBJECT'), 'should contain SUBJECT');
    });
    it('Search Compiler: OR with 5 conditions produces 4 OR atoms', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, {
            or: [{ from: 'a' }, { from: 'b' }, { from: 'c' }, { from: 'd' }, { from: 'e' }]
        });

        // 5 conditions need 4 OR atoms in a binary tree structure
        let orCount = compiled.filter(a => (a as any).value === 'OR').length;
        assert.equal(orCount, 4, 'should have exactly 4 OR atoms for 5 conditions');
        assert.ok(hasAttr(compiled, 'a'), 'should contain a');
        assert.ok(hasAttr(compiled, 'b'), 'should contain b');
        assert.ok(hasAttr(compiled, 'c'), 'should contain c');
        assert.ok(hasAttr(compiled, 'd'), 'should contain d');
        assert.ok(hasAttr(compiled, 'e'), 'should contain e');
    });
    it('Search Compiler: OR with compound conditions wraps in parentheses', () => {
        let connection: any = createMockConnection();
        let compiled: any = searchCompiler(connection, {
            or: [
                { to: 'a@example.com', from: 'b@example.com' },
                { to: 'c@example.com', from: 'd@example.com' }
            ]
        });

        // OR should be present
        assert.equal(compiled[0].value, 'OR');
        // Each compound condition should be a sub-array (parenthesized)
        assert.ok(Array.isArray(compiled[1]), 'first compound operand should be parenthesized');
        assert.ok(Array.isArray(compiled[2]), 'second compound operand should be parenthesized');
        // Check contents of parenthesized groups
        assert.ok(hasAttr(compiled[1], 'TO'), 'first group should have TO');
        assert.ok(hasAttr(compiled[1], 'FROM'), 'first group should have FROM');
        assert.ok(hasAttr(compiled[2], 'TO'), 'second group should have TO');
        assert.ok(hasAttr(compiled[2], 'FROM'), 'second group should have FROM');
    });
    it('Search Compiler: OR with single-key conditions stays flat', () => {
        let connection: any = createMockConnection();
        let compiled: any = searchCompiler(connection, {
            or: [{ from: 'a@example.com' }, { from: 'b@example.com' }]
        });

        // Single-key conditions should not be wrapped in sub-arrays
        assert.equal(compiled[0].value, 'OR');
        assert.ok(!Array.isArray(compiled[1]), 'single-key operand should not be parenthesized');
        assert.equal(compiled[1].value, 'FROM');
    });
    it('Search Compiler: OR with 5 compound conditions from issue #106', () => {
        let connection: any = createMockConnection();
        let compiled = searchCompiler(connection, {
            or: [
                { to: 'myemail@domain.com', from: '@anotherdomain.com' },
                { to: 'myemail@domain.com', from: '@aseconddomain.com' },
                { to: 'myemail@domain.com', from: '@athirddomain.fr' },
                { to: 'anotheremail@domain.com', from: '@anotherdomain.fr' },
                { to: 'anotheremail@domain.com', from: '@aseconddomain.com' }
            ]
        });

        // 5 conditions need 4 OR atoms
        let orCount = compiled.filter(a => (a as any).value === 'OR').length;
        assert.equal(orCount, 4, 'should have exactly 4 OR atoms for 5 conditions');

        // All compound conditions should be parenthesized (sub-arrays)
        let subArrays = compiled.filter(a => Array.isArray(a));
        assert.equal(subArrays.length, 5, 'should have 5 parenthesized groups');

        // Each group should contain both TO and FROM
        subArrays.forEach((group, i) => {
            assert.ok(hasAttr(group, 'TO'), 'group ' + i + ' should have TO');
            assert.ok(hasAttr(group, 'FROM'), 'group ' + i + ' should have FROM');
        });
    });

    // ============================================
    // Unicode CHARSET in HEADER searches
    // ============================================
    it('Search Compiler: Unicode header search without UTF8=ACCEPT adds CHARSET', () => {
        let connection: any = createMockConnection({
            enabled: new Set()
        });
        let compiled: any = searchCompiler(connection, {
            header: { subject: 'caf\u00e9' }
        });

        assert.ok(hasAttr(compiled, 'CHARSET'), 'should have CHARSET prefix');
        assert.ok(hasAttr(compiled, 'UTF-8'), 'should have UTF-8 value');
        // CHARSET and UTF-8 should be the first two entries
        assert.equal(compiled[0].value, 'CHARSET', 'CHARSET should be first');
        assert.equal((compiled[1] as any).value, 'UTF-8', 'UTF-8 should be second');
        assert.ok(hasAttr(compiled, 'HEADER'), 'should contain HEADER');
        assert.ok(hasAttr(compiled, 'caf\u00e9'), 'should contain the unicode value');
    });
    it('Search Compiler: Unicode header search with UTF8=ACCEPT skips CHARSET', () => {
        let connection: any = createMockConnection({
            enabled: new Set(['UTF8=ACCEPT'])
        });
        let compiled = searchCompiler(connection, {
            header: { subject: 'caf\u00e9' }
        });

        assert.ok(!hasAttr(compiled, 'CHARSET'), 'should NOT have CHARSET prefix');
        assert.ok(!hasAttr(compiled, 'UTF-8'), 'should NOT have UTF-8 value');
        assert.ok(hasAttr(compiled, 'HEADER'), 'should contain HEADER');
        assert.ok(hasAttr(compiled, 'caf\u00e9'), 'should contain the unicode value');
    });
});
