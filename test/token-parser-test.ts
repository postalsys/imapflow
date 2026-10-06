/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parser } from '../src/handler/imap-handler.js';

// ---------------------------------------------------------------------------
// Additional error-path and edge-case coverage (E11, E12, E16, E17, E19-E22,
// E24, E27) plus the bare-"*" sequence and "~"-as-atom normalization paths.
// All use a non-status command (FETCH) so the TokenParser is actually invoked.
// ---------------------------------------------------------------------------

const expectParserError = (input: string, code: string) => async () => {
    let err: any;
    try {
        await parser(input);
    } catch (e) {
        err = e;
    }
    if (!err) throw new Error('Expected parser to throw but it did not');
    assert.equal(err.code, code);
};

describe('token-parser', () => {
    // Error path tests
    //
    // NOTE: All error inputs use a non-status command (FETCH) rather than OK/NO/BAD/BYE.
    // Status commands consume their entire remainder as human-readable text and never
    // invoke the TokenParser, so errors like E9/E10/E13 cannot be triggered through
    // the public parser() API when the command is a status response.
    //
    // Error-path tests use asyncWrapper with an internal try/catch so that err.code
    // can be asserted. The handler re-throws when no error was caught so that a missing
    // rejection is still surfaced as a test failure.

    /**
     * E9: Unclosed quoted string. The node's isClosed flag remains false when
     * getAttributes() walks the tree, triggering ParserError9.
     */
    it('Token Parser: E9: unclosed quoted string throws ParserError9', async () => {
        let err: any;
        try {
            await parser('* FETCH "unterminated');
        } catch (e) {
            err = e;
        }
        if (!err) throw new Error('Expected parser to throw but it did not');
        assert.ok(err, 'expected an error to be thrown');
        assert.equal(err.code, 'ParserError9');
    });

    /**
     * E10: Unexpected list terminator. A ')' is encountered when the current node
     * is not a LIST node, triggering ParserError10.
     */
    it('Token Parser: E10: unexpected ) throws ParserError10', async () => {
        let err: any;
        try {
            await parser('* FETCH )');
        } catch (e) {
            err = e;
        }
        if (!err) throw new Error('Expected parser to throw but it did not');
        assert.ok(err, 'expected an error to be thrown');
        assert.equal(err.code, 'ParserError10');
    });

    /**
     * E13: Unexpected control character. A character below 0x80 that is not in
     * ATOM-CHAR and not one of the explicitly allowed exceptions (\, %) triggers
     * ParserError13 in the STATE_NORMAL default branch.
     * \x01 is a control character excluded from ATOM-CHAR.
     */
    it('Token Parser: E13: control character in attribute position throws ParserError13', async () => {
        let err: any;
        try {
            await parser('* FETCH \x01rest');
        } catch (e) {
            err = e;
        }
        if (!err) throw new Error('Expected parser to throw but it did not');
        assert.ok(err, 'expected an error to be thrown');
        assert.equal(err.code, 'ParserError13');
    });

    /**
     * E18: Backslash escape at end of quoted string input. When a backslash is
     * encountered in STATE_STRING and there is no following character (i >= len),
     * ParserError18 is thrown.
     * The JS string '* FETCH "test\\' represents the IMAP input: * FETCH "test\
     */
    it('Token Parser: E18: escape at end of quoted string throws ParserError18', async () => {
        let err: any;
        try {
            await parser('* FETCH "test\\');
        } catch (e) {
            err = e;
        }
        if (!err) throw new Error('Expected parser to throw but it did not');
        assert.ok(err, 'expected an error to be thrown');
        assert.equal(err.code, 'ParserError18');
    });

    /**
     * E23: Empty literal braces. When '}' is encountered in STATE_LITERAL before
     * any digit has been stored in literalLength, ParserError23 is thrown because
     * the check is: if (!('literalLength' in this.currentNode)) throw E23.
     */
    it('Token Parser: E23: empty literal braces throws ParserError23', async () => {
        let err: any;
        try {
            await parser('* FETCH {}', { literals: [] });
        } catch (e) {
            err = e;
        }
        if (!err) throw new Error('Expected parser to throw but it did not');
        assert.ok(err, 'expected an error to be thrown');
        assert.equal(err.code, 'ParserError23');
    });

    /**
     * E25: Non-digit character inside literal size braces. Any character inside
     * {...} that is not a digit (and not '}' or '+' with literalPlus) triggers
     * ParserError25.
     */
    it('Token Parser: E25: non-digit in literal size throws ParserError25', async () => {
        let err: any;
        try {
            await parser('* FETCH {abc}', { literals: [] });
        } catch (e) {
            err = e;
        }
        if (!err) throw new Error('Expected parser to throw but it did not');
        assert.ok(err, 'expected an error to be thrown');
        assert.equal(err.code, 'ParserError25');
    });

    /**
     * E26: Leading zero in literal size. After '0' is stored as literalLength,
     * any following digit triggers ParserError26 because a leading zero is invalid.
     */
    it('Token Parser: E26: leading zero in literal size throws ParserError26', async () => {
        let err: any;
        try {
            await parser('* FETCH {01}', { literals: [Buffer.from('x')] });
        } catch (e) {
            err = e;
        }
        if (!err) throw new Error('Expected parser to throw but it did not');
        assert.ok(err, 'expected an error to be thrown');
        assert.equal(err.code, 'ParserError26');
    });

    /**
     * MAX_IMAP_NESTING_REACHED: Nesting depth exceeds MAX_NODE_DEPTH (25).
     * createNode() throws when node.depth > 25. The root TREE node starts at
     * depth 0, so depth 1 is the first LIST ('('), and 26 open parens reaches
     * depth 26 which exceeds the limit.
     */
    it('Token Parser: MAX_IMAP_NESTING_REACHED: deep nesting throws MAX_IMAP_NESTING_REACHED', async () => {
        let err: any;
        try {
            const depth = 26;
            const input = '* FETCH ' + '('.repeat(depth) + 'x' + ')'.repeat(depth);
            await parser(input);
        } catch (e) {
            err = e;
        }
        if (!err) throw new Error('Expected parser to throw but it did not');
        assert.ok(err, 'expected an error to be thrown');
        assert.equal(err.code, 'MAX_IMAP_NESTING_REACHED');
    });

    it('Token Parser: nesting exactly at MAX_NODE_DEPTH is accepted', async () => {
        // the limit is inclusive and counts every node: 25 nested lists parse, while 25 lists
        // around an atom (26 levels) are refused like the test above
        let parsed = await parser('* FETCH ' + '('.repeat(25) + ')'.repeat(25));
        let node: any = parsed.attributes;
        for (let i = 0; i < 25; i++) {
            assert.equal(node.length, 1);
            node = node[0];
        }
        assert.deepEqual(node, []);
        await assert.rejects(parser('* FETCH ' + '('.repeat(25) + 'x' + ')'.repeat(25)), { code: 'MAX_IMAP_NESTING_REACHED' });
    });

    it('Token Parser: E35: a literal marker without a supplied buffer throws ParserError35', async () => {
        // supplied buffers must match the markers one to one, {0} included
        await assert.rejects(parser('* X {3}\r\n', { literals: [] }), { code: 'ParserError35' });
        await assert.rejects(parser('* X {0}\r\n', { literals: [] }), { code: 'ParserError35' });
        await assert.rejects(parser('* X {0}\r\n {3}\r\n', { literals: [Buffer.alloc(0)] }), { code: 'ParserError35' });
        assert.deepEqual((await parser('* X {0}\r\n {3}\r\n', { literals: [Buffer.alloc(0), Buffer.from('abc')] })).attributes, [
            { type: 'LITERAL', value: Buffer.alloc(0) },
            { type: 'LITERAL', value: Buffer.from('abc') }
        ]);
    });

    it('Token Parser: E24: literal marker followed by a bare CR throws ParserError24', async () => {
        // "}" must be followed by LF or CRLF; a CR alone is not a line break
        await assert.rejects(parser('* X {3}\rabc'), { code: 'ParserError24' });
        await assert.rejects(parser('* X {3}\r\rabc'), { code: 'ParserError24' });
        assert.deepEqual((await parser('* X {3}\r\nabc')).attributes, [{ type: 'LITERAL', value: 'abc' }]);
    });

    // Happy-path tests

    /**
     * NIL atom is returned as null in the attributes array. The ATOM node whose
     * value is "NIL" (case-insensitive) is converted to null in getAttributes().
     */
    it('Token Parser: NIL atom is parsed as null', async () => {
        const result = await parser('* FETCH NIL');
        const attrs = result.attributes;
        assert.ok(Array.isArray(attrs), 'attributes should be an array');
        assert.equal(attrs.length, 1, 'should have exactly one attribute');
        assert.strictEqual(attrs[0], null, 'NIL should be parsed as null');
    });

    /**
     * Nested lists produce nested arrays in the attributes output.
     * Input ((a b)) produces: [ [ [ {a}, {b} ] ] ], the attributes array contains
     * one outer list which contains one inner list with two atom elements.
     */
    it('Token Parser: nested lists produce nested arrays', async () => {
        const result = await parser('* FETCH ((a b))');
        const attrs = result.attributes;
        assert.ok(Array.isArray(attrs), 'attributes should be an array');
        const outer = attrs[0];
        assert.ok(Array.isArray(outer), 'outer list should be an array');
        const inner: any = outer[0];
        assert.ok(Array.isArray(inner), 'inner list should be an array');
        assert.equal(inner.length, 2, 'inner list should have 2 elements');
        assert.equal(inner[0].value, 'a', 'first inner element value should be a');
        assert.equal(inner[1].value, 'b', 'second inner element value should be b');
    });

    /**
     * Quoted string with escaped double-quote characters. The backslash-escape
     * mechanism converts \" to " in the parsed value. The JS literal
     * '* FETCH "hello \\"world\\""' represents: * FETCH "hello \"world\""
     */
    it('Token Parser: quoted string with escaped quotes is parsed correctly', async () => {
        const result = await parser('* FETCH "hello \\"world\\""');
        const attrs: any = result.attributes;
        assert.ok(Array.isArray(attrs), 'attributes should be an array');
        assert.equal(attrs.length, 1, 'should have exactly one attribute');
        assert.equal(attrs[0].type, 'STRING', 'type should be STRING');
        assert.equal(attrs[0].value, 'hello "world"', 'escaped quotes should be unescaped');
    });

    /**
     * Empty quoted string results in a STRING attribute with an empty value.
     */
    it('Token Parser: empty quoted string produces STRING with empty value', async () => {
        const result = await parser('* FETCH ""');
        const attrs: any = result.attributes;
        assert.ok(Array.isArray(attrs), 'attributes should be an array');
        assert.equal(attrs.length, 1, 'should have exactly one attribute');
        assert.equal(attrs[0].type, 'STRING', 'type should be STRING');
        assert.equal(attrs[0].value, '', 'value should be empty string');
    });

    /**
     * Literal data provided via the literals option is parsed into a LITERAL attribute.
     * When options.literals is set and '}' is encountered with a valid size, the next
     * Buffer in the literals array is used as the literal value directly.
     * The literal size in braces must be followed by \r\n or \n per IMAP protocol.
     */
    it('Token Parser: literal with pre-parsed data produces LITERAL attribute', async () => {
        const data = Buffer.from('hello');
        const result = await parser('* FETCH {5}\r\n', { literals: [data] });
        const attrs: any = result.attributes;
        assert.ok(Array.isArray(attrs), 'attributes should be an array');
        assert.equal(attrs.length, 1, 'should have exactly one attribute');
        assert.equal(attrs[0].type, 'LITERAL', 'type should be LITERAL');
        assert.ok(Buffer.isBuffer(attrs[0].value), 'literal value should be a Buffer');
        assert.equal(attrs[0].value.toString(), 'hello', 'literal value should match provided buffer');
    });

    /**
     * A plain ATOM token produces an ATOM attribute with the correct string value.
     */
    it('Token Parser: atom value produces ATOM attribute', async () => {
        const result = await parser('* FETCH INBOX');
        const attrs: any = result.attributes;
        assert.ok(Array.isArray(attrs), 'attributes should be an array');
        assert.equal(attrs.length, 1, 'should have exactly one attribute');
        assert.equal(attrs[0].type, 'ATOM', 'type should be ATOM');
        assert.equal(attrs[0].value, 'INBOX', 'value should be INBOX');
    });

    /**
     * E29: Range separator ':' after a character that is not a digit or '*', in a token holding
     * '*'. Input "1:*,:" passes "1:*," (a range ending in '*' may be followed by ','), then ':'
     * after ',' fires E29. A token without '*' is read as an atom instead, see the
     * "digit-led atoms" tests below.
     */
    it('Token Parser: E29: range separator after non-digit/non-star throws ParserError29', async () => {
        await assert.rejects(parser('* FETCH 1:*,:5'), { code: 'ParserError29' });
    });

    /**
     * E30: Wildcard '*' when last char is not ',' or ':'.
     * Input "1:2*" enters SEQUENCE after "1:" and appends "2" (value "1:2").
     * Then '*' fires E30 because last char '2' is not ',' or ':'.
     */
    it('Token Parser: E30: wildcard after digit throws ParserError30', async () => {
        let err: any;
        try {
            await parser('* FETCH 1:2*');
        } catch (e) {
            err = e;
        }
        if (!err) throw new Error('Expected parser to throw but it did not');
        assert.ok(err, 'expected an error to be thrown');
        assert.equal(err.code, 'ParserError30');
    });

    /**
     * E31: Separator ',' after a character that is not a digit or '*', in a token holding '*'.
     * Input "5:*:," appends ':' after '*' (value "5:*:"), then ',' fires E31 because the last
     * char ':' is not a digit or '*'.
     */
    it('Token Parser: E31: comma after colon throws ParserError31', async () => {
        await assert.rejects(parser('* FETCH 5:*:,5'), { code: 'ParserError31' });
    });

    /**
     * E32: Separator ',' after bare '*' (not in a range).
     * Input "*,5" starts SEQUENCE with value "*". Then ',' passes E31
     * (last char '*' satisfies the check) but fires E32 because last char
     * is '*' and the char before it (at(-2)) is not ':'.
     */
    it('Token Parser: E32: comma after bare star throws ParserError32', async () => {
        let err: any;
        try {
            await parser('* FETCH *,5');
        } catch (e) {
            err = e;
        }
        if (!err) throw new Error('Expected parser to throw but it did not');
        assert.ok(err, 'expected an error to be thrown');
        assert.equal(err.code, 'ParserError32');
    });

    /**
     * E33: Non-digit, non-special character in a sequence holding '*'. Input "1:*a" can not be
     * an atom ('*' is not an ATOM-CHAR), so 'a' fires E33.
     */
    it('Token Parser: E33: non-digit non-special char in sequence throws ParserError33', async () => {
        await assert.rejects(parser('* FETCH 1:*a'), { code: 'ParserError33' });
    });

    /**
     * E34: Digit immediately after '*'.
     * Input "*1" starts SEQUENCE with value "*". Then '1' is a digit but
     * last char is '*', so E34 fires (digits cannot follow '*').
     */
    it('Token Parser: E34: digit after star throws ParserError34', async () => {
        let err: any;
        try {
            await parser('* FETCH *1');
        } catch (e) {
            err = e;
        }
        if (!err) throw new Error('Expected parser to throw but it did not');
        assert.ok(err, 'expected an error to be thrown');
        assert.equal(err.code, 'ParserError34');
    });
    it('Token Parser: REFERRAL response code is parsed as an IMAP URL atom', async () => {
        let r: any = await parser('* OK [REFERRAL imap://user@host/INBOX] please use another server');
        let section: any = r.attributes[0].section;
        assert.equal(section[0].value, 'REFERRAL');
        assert.equal(section![1].value, 'imap://user@host/INBOX');
    });
    it('Token Parser: REFERRAL URL with an IPv6 host keeps its brackets', async () => {
        let r: any = await parser('* NO [REFERRAL imap://user@[::1]:143/INBOX] please use another server');
        let section: any = r.attributes[0].section;
        assert.equal(section[1].value, 'imap://user@[::1]:143/INBOX');
        assert.equal(r.attributes[1].value, 'please use another server');
    });
    it('Token Parser: REFERRAL URL with an IPv6 host at the end of the input', async () => {
        let r: any = await parser('* NO [REFERRAL imap://[::1]/INBOX]');
        let section: any = r.attributes[0].section;
        assert.equal(section[1].value, 'imap://[::1]/INBOX');
    });
    it('Token Parser: REFERRAL section closed without a following space', async () => {
        let r: any = await parser('* NO [REFERRAL imap://[::1]/INBOX]text');
        let section: any = r.attributes[0].section;
        assert.equal(section[1].value, 'imap://[::1]/INBOX');
    });
    it('Token Parser: malformed REFERRAL with no closing bracket consumes the rest', async () => {
        // Missing ']' previously produced a negative-index substring (garbage). The whole
        // remaining string should be captured as the URL instead, without throwing.
        let r: any = await parser('* OK [REFERRAL imap://user@host/INBOX');
        let section: any = r.attributes[0].section;
        assert.equal(section[0].value, 'REFERRAL');
        assert.equal(section![1].value, 'imap://user@host/INBOX');
    });
    it('Token Parser: E11: unexpected ] throws ParserError11', expectParserError('* 1 FETCH (])', 'ParserError11'));
    it('Token Parser: E12: ~ not followed by { throws ParserError12', expectParserError('* 1 FETCH ~%', 'ParserError12'));
    it('Token Parser: E16: \\* followed by char throws ParserError17', expectParserError('* 1 FETCH \\*x', 'ParserError17'));
    it('Token Parser: E19: partial ending with . throws ParserError19', expectParserError('* 1 FETCH BODY[]<0.>', 'ParserError19'));
    it('Token Parser: E20: partial leading . throws ParserError20', expectParserError('* 1 FETCH BODY[]<.>', 'ParserError20'));
    it('Token Parser: E21: non-digit in partial throws ParserError21', expectParserError('* 1 FETCH BODY[]<0.x>', 'ParserError21'));
    it('Token Parser: E22: invalid leading-zero partial throws ParserError22', expectParserError('* 1 FETCH BODY[]<00>', 'ParserError22'));
    it('Token Parser: E24: literal prefix not followed by CRLF throws ParserError24', expectParserError('* 1 FETCH {3}xyz', 'ParserError24'));
    it(
        'Token Parser: E27: whitespace after a dangling separator in a starred sequence throws ParserError27',
        expectParserError('* 1 FETCH 1:*, 2', 'ParserError27')
    );
    it('Token Parser: bare * is normalized to an ATOM', async () => {
        let r: any = await parser('* 1 FETCH *');
        let last: any = r.attributes[r.attributes!.length - 1];
        assert.equal(last.type, 'ATOM');
        assert.equal(last!.value, '*');
    });
    it('Token Parser: ~ followed by atom chars becomes an ATOM', async () => {
        let r: any = await parser('* 1 FETCH ~abc');
        let last: any = r.attributes[r.attributes!.length - 1];
        assert.equal(last.type, 'ATOM');
        assert.equal(last!.value, '~abc');
    });
    it('Token Parser: E16: invalid char in atom throws ParserError16', expectParserError('* 1 FETCH 3* 4', 'ParserError16'));
    it('Token Parser: literal+ (non-synchronizing) marker is accepted', async () => {
        // {3+} is a LITERAL+ prefix; with literalPlus enabled and no pre-parsed
        // literals, the parser reads the literal bytes inline.
        let r: any = await parser('* 1 FETCH {3+}\r\nabc', { literalPlus: true });
        let lit: any = r.attributes[r.attributes!.length - 1];
        assert.equal(lit.type, 'LITERAL');
        assert.equal(lit!.value!.toString(), 'abc');
    });
    it('Token Parser: literal prefix terminated by bare LF is accepted', async () => {
        let r: any = await parser('* 1 FETCH {3}\nabc');
        let lit: any = r.attributes[r.attributes!.length - 1];
        assert.equal(lit.type, 'LITERAL');
        assert.equal(lit!.value!.toString(), 'abc');
    });

    // Glued flags ("\\Sent\\HasNoChildren", see the STATE_ATOM branch of token-parser.ts)
    // are only split inside a list, only off an atom that already is a flag, and only
    // when a flag name follows. Everything else keeps failing as before
    it(
        'Token Parser: E16: backslash inside a non-flag atom still throws ParserError16',
        expectParserError('* LIST (HasNoChildren\\Sent) "/" "x"', 'ParserError16')
    );
    it('Token Parser: E16: doubled backslash still throws ParserError16', expectParserError('* LIST (\\\\Sent) "/" "x"', 'ParserError16'));
    it('Token Parser: E16: trailing backslash in a flag still throws ParserError16', expectParserError('* LIST (\\Sent\\) "/" "x"', 'ParserError16'));
    it('Token Parser: E16: backslash followed by a space still throws ParserError16', expectParserError('* LIST (\\Sent\\ \\Drafts) "/" "x"', 'ParserError16'));
    it('Token Parser: E16: glued flags outside a list still throw ParserError16', expectParserError('* 1 FETCH \\Seen\\Flagged', 'ParserError16'));

    // Cases found by mutation testing (npm run test:mutation)

    it('Token Parser: E9 reports the position in the whole response line', async () => {
        // the token parser only sees the attribute part, so the reported position adds the
        // offset of that part in the line
        await assert.rejects(parser('* X "abc'), (err: any) => {
            assert.equal(err.code, 'ParserError9');
            assert.match(err.message, /at position 7 /);
            assert.equal(err.parserContext.pos, 7);
            return true;
        });
    });

    it('Token Parser: E9: every unterminated token is refused', async () => {
        // one open token per input, so no enclosing open list reports it instead
        for (let input of ['* X "abc', '* X (a', '* 1 FETCH BODY[]<0', '* X {3', '* OK [UIDNEXT 3', '* 1 FETCH BODY[HEADER']) {
            await assert.rejects(parser(input), { code: 'ParserError9' }, input);
        }
    });

    it('Token Parser: REFERRAL response code keeps the whole IMAP URL', async () => {
        let parsed = await parser('* OK [REFERRAL imap://user@host/INBOX] go there');
        assert.deepEqual(parsed.attributes, [
            {
                type: 'ATOM',
                value: '',
                section: [
                    { type: 'ATOM', value: 'REFERRAL' },
                    { type: 'ATOM', value: 'imap://user@host/INBOX' }
                ]
            },
            { type: 'TEXT', value: 'go there' }
        ]);
    });

    it('Token Parser: 8-bit characters are accepted in atoms, from U+0080 on', async () => {
        assert.deepEqual((await parser('* X \u0080abc')).attributes, [{ type: 'ATOM', value: '\u0080abc' }]);
        assert.deepEqual((await parser('* X a\u0080bc')).attributes, [{ type: 'ATOM', value: 'a\u0080bc' }]);
    });

    it('Token Parser: atoms in a status response code may carry non-atom characters', async () => {
        let parsed = await parser('* OK [X-FOO a%b] t');
        assert.deepEqual((parsed.attributes as any)[0].section, [
            { type: 'ATOM', value: 'X-FOO' },
            { type: 'ATOM', value: 'a%b' }
        ]);
    });

    it('Token Parser: a lone ~ is an atom where a list or section closes after it', async () => {
        assert.deepEqual((await parser('* X (~)')).attributes, [[{ type: 'ATOM', value: '~' }]]);
        assert.deepEqual((await parser('* 1 FETCH (BODY[~])')).attributes, [
            { type: 'ATOM', value: 'FETCH' },
            [{ type: 'ATOM', value: 'BODY', section: [{ type: 'ATOM', value: '~' }] }]
        ]);
    });

    it('Token Parser: E12: ~ followed by a non-atom character inside a list or section', async () => {
        await assert.rejects(parser('* X (~%)'), { code: 'ParserError12' });
        await assert.rejects(parser('* 1 FETCH (BODY[~%])'), { code: 'ParserError12' });
    });

    it('Token Parser: an inline literal exactly at maxLiteralSize is accepted', async () => {
        assert.deepEqual((await parser('* X {3}\r\nabc', { maxLiteralSize: 3 })).attributes, [{ type: 'LITERAL', value: 'abc' }]);
        await assert.rejects(parser('* X {3}\r\nabc', { maxLiteralSize: 2 }), { code: 'LiteralTooLarge' });
    });
});

// A digit-led token is read as a sequence set only while it follows the sequence grammar. ":" and
// "," are ATOM-CHARs, so servers send mailbox names, keywords and labels like "2024:Q1" unquoted
// (Dovecot 2.4 does), and such a token must parse as an atom wherever it stands.
describe('token-parser: digit-led atoms', () => {
    // tokens that start like a sequence set but are not one
    const atoms = ['2024:Q1', '1,a', '1:a', '10:', '10,', '1::2', '1,,2', '1:,5', '1,:5', '12:30:x', '1:2:3a', '1,2,b', '7:-1', '2024:Q1.Reports', '1:été'];

    // every place a token can end: the end of the line, a space, a list or section delimiter
    const positions: Array<[string, (token: string) => string, (token: any) => any]> = [
        ['at the end of the line', token => `* LIST () "/" ${token}`, token => [[], { type: 'STRING', value: '/' }, token]],
        [
            'before a space',
            token => `* STATUS ${token} (MESSAGES 3)`,
            token => [
                token,
                [
                    { type: 'ATOM', value: 'MESSAGES' },
                    { type: 'ATOM', value: '3' }
                ]
            ]
        ],
        ['last in a list', token => `* FLAGS (\\Seen ${token})`, token => [[{ type: 'ATOM', value: '\\Seen' }, token]]],
        ['first in a list', token => `* FLAGS (${token} \\Seen)`, token => [[token, { type: 'ATOM', value: '\\Seen' }]]],
        [
            'alone in a list',
            token => `* 1 FETCH (X-GM-LABELS (${token}))`,
            token => [{ type: 'ATOM', value: 'FETCH' }, [{ type: 'ATOM', value: 'X-GM-LABELS' }, [token]]]
        ],
        [
            'last in a response code',
            token => `* OK [PERMANENTFLAGS (\\Seen ${token})] Limited`,
            token => [
                { type: 'ATOM', value: '', section: [{ type: 'ATOM', value: 'PERMANENTFLAGS' }, [{ type: 'ATOM', value: '\\Seen' }, token]] },
                { type: 'TEXT', value: 'Limited' }
            ]
        ],
        [
            'last in a section',
            token => `* 1 FETCH (BODY[${token}] NIL)`,
            token => [{ type: 'ATOM', value: 'FETCH' }, [{ type: 'ATOM', value: 'BODY', section: [token] }, null]]
        ]
    ];

    for (const value of atoms) {
        for (const [where, line, expected] of positions) {
            it(`reads ${JSON.stringify(value)} ${where} as an atom`, async () => {
                assert.deepEqual((await parser(line(value))).attributes, expected({ type: 'ATOM', value }));
            });
        }
    }

    // well-formed sequence sets are still sequence sets, in the same positions
    for (const value of ['1:5', '1,3:5,10', '5:*', '1:*,7', '12:30:00', '4294967295:1']) {
        for (const [where, line, expected] of positions) {
            it(`keeps the sequence set ${JSON.stringify(value)} ${where}`, async () => {
                assert.deepEqual((await parser(line(value))).attributes, expected({ type: 'SEQUENCE', value }));
            });
        }
    }

    it('keeps a single number an atom', async () => {
        assert.deepEqual((await parser('* SEARCH 12 3')).attributes, [
            { type: 'ATOM', value: '12' },
            { type: 'ATOM', value: '3' }
        ]);
    });

    it('splits on the space after the atom and reads the next token on its own', async () => {
        assert.deepEqual((await parser('* X 2024:Q1 1:5 1,a 7')).attributes, [
            { type: 'ATOM', value: '2024:Q1' },
            { type: 'SEQUENCE', value: '1:5' },
            { type: 'ATOM', value: '1,a' },
            { type: 'ATOM', value: '7' }
        ]);
    });

    it('applies the atom rules to the rest of the token', async () => {
        // characters an atom can not hold still fail, now under the atom error
        for (const line of ['* X 1:a(', '* X 1:a"b"', '* X 1:a{3}', '* X 1:%', '* X 1,\\a']) {
            await assert.rejects(parser(line), (err: any) => typeof err.code === 'string' && err.code.startsWith('ParserError'), line);
        }
    });

    it('keeps the sequence errors for a token holding "*", which can not be an atom', async () => {
        for (const [line, code] of [
            ['* X 1:*a', 'ParserError33'],
            ['* X 1:*,:5', 'ParserError29'],
            ['* X 5:*:,5', 'ParserError31'],
            ['* X 1:*, 2', 'ParserError27'],
            ['* X 1:2*', 'ParserError30'],
            ['* X *,5', 'ParserError32'],
            ['* X *1', 'ParserError34']
        ]) {
            await assert.rejects(parser(line), { code }, line);
        }
    });

    it('reads a starred token that ends the line on a separator as it did before', async () => {
        // the end-of-input conversion only applies to tokens that can be atoms
        assert.deepEqual((await parser('* X 1:*,')).attributes, [{ type: 'SEQUENCE', value: '1:*,' }]);
    });
});

describe('token-parser: tracked token facts', () => {
    // These checks read what the tokenizer tracked while appending, not the token value, so the
    // boundaries of each one are pinned here

    it('rejects a second "." in a partial range', async () => {
        await assert.rejects(parser('* 1 FETCH (BODY[]<1.2.3> NIL)'), { code: 'ParserError20' });
        await assert.rejects(parser('* 1 FETCH (BODY[]<.1> NIL)'), { code: 'ParserError20' });
        assert.deepEqual((await parser('* 1 FETCH (BODY[]<10.20> NIL)')).attributes, [
            { type: 'ATOM', value: 'FETCH' },
            [{ type: 'ATOM', value: 'BODY', section: [], partial: [10, 20] }, null]
        ]);
    });

    it('rejects a leading zero in either number of a partial range', async () => {
        await assert.rejects(parser('* 1 FETCH (BODY[]<01> NIL)'), { code: 'ParserError22' });
        await assert.rejects(parser('* 1 FETCH (BODY[]<1.01> NIL)'), { code: 'ParserError22' });
        assert.deepEqual((await parser('* 1 FETCH (BODY[]<0.10> NIL)')).attributes, [
            { type: 'ATOM', value: 'FETCH' },
            [{ type: 'ATOM', value: 'BODY', section: [], partial: [0, 10] }, null]
        ]);
    });

    it('opens a section after every section-taking name, the longest one included', async () => {
        for (const name of ['BODY', 'BODY.PEEK', 'BINARY', 'BINARY.PEEK', 'binary.peek']) {
            assert.deepEqual((await parser(`* 1 FETCH (${name}[1] NIL)`)).attributes, [
                { type: 'ATOM', value: 'FETCH' },
                [{ type: 'ATOM', value: name, section: [{ type: 'ATOM', value: '1' }] }, null]
            ]);
        }
        // a longer name is an ordinary atom that holds the bracket
        assert.deepEqual((await parser('* 1 FETCH (BINARY.PEEKX[1] NIL)')).attributes, [
            { type: 'ATOM', value: 'FETCH' },
            [{ type: 'ATOM', value: 'BINARY.PEEKX[1]' }, null]
        ]);
    });
});

// The tokenizer must stay linear in the token length. Reading a token's last character back from a
// string built with += makes V8 copy the whole string on every character, and a server decides how
// long a sequence set, atom or partial range is: before the fix a 600 KB ESEARCH ALL result blocked
// the event loop for seconds. 1 MB tokens parse in milliseconds when linear and take minutes when
// quadratic, so the generous bound below does not depend on the speed of the machine
describe('token-parser: long tokens parse in linear time', () => {
    const size = 1024 * 1024;
    const uids = Array.from({ length: size / 8 }, (_, i) => String(1000000 + i)).join(',');
    const cases: Array<[string, string]> = [
        ['a sequence set', `* ESEARCH (TAG "A1") UID ALL ${uids}`],
        ['a sequence set in a list', `* X (${uids})`],
        ['a digit-led atom', `* X 1:${'a,'.repeat(size / 2)}a`],
        ['an atom with commas', `* X ${'a,'.repeat(size / 2)}a`],
        ['an atom with brackets', `* X ${'a['.repeat(size / 2)}a`],
        ['a partial range', `* 1 FETCH (BODY[]<1.${'1'.repeat(size)}> NIL)`]
    ];
    for (const [name, line] of cases) {
        it(`parses ${name} of ${line.length} bytes`, async () => {
            const started = Date.now();
            await parser(line).catch(() => false);
            assert.ok(Date.now() - started < 3000, `took ${Date.now() - started}ms`);
        });
    }
});
