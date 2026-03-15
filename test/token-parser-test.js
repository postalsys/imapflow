/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

'use strict';

const { parser } = require('../lib/handler/imap-handler');

let asyncWrapper = (test, handler) => {
    handler(test)
        .then(() => test.done())
        .catch(err => {
            test.ifError(err);
            test.done();
        });
};

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
module.exports['Token Parser: E9: unclosed quoted string throws ParserError9'] = test =>
    asyncWrapper(test, async test => {
        let err;
        try {
            await parser('* FETCH "unterminated');
        } catch (e) {
            err = e;
        }
        if (!err) throw new Error('Expected parser to throw but it did not');
        test.ok(err, 'expected an error to be thrown');
        test.equal(err.code, 'ParserError9');
    });

/**
 * E10: Unexpected list terminator. A ')' is encountered when the current node
 * is not a LIST node, triggering ParserError10.
 */
module.exports['Token Parser: E10: unexpected ) throws ParserError10'] = test =>
    asyncWrapper(test, async test => {
        let err;
        try {
            await parser('* FETCH )');
        } catch (e) {
            err = e;
        }
        if (!err) throw new Error('Expected parser to throw but it did not');
        test.ok(err, 'expected an error to be thrown');
        test.equal(err.code, 'ParserError10');
    });

/**
 * E13: Unexpected control character. A character below 0x80 that is not in
 * ATOM-CHAR and not one of the explicitly allowed exceptions (\, %) triggers
 * ParserError13 in the STATE_NORMAL default branch.
 * \x01 is a control character excluded from ATOM-CHAR.
 */
module.exports['Token Parser: E13: control character in attribute position throws ParserError13'] = test =>
    asyncWrapper(test, async test => {
        let err;
        try {
            await parser('* FETCH \x01rest');
        } catch (e) {
            err = e;
        }
        if (!err) throw new Error('Expected parser to throw but it did not');
        test.ok(err, 'expected an error to be thrown');
        test.equal(err.code, 'ParserError13');
    });

/**
 * E18: Backslash escape at end of quoted string input. When a backslash is
 * encountered in STATE_STRING and there is no following character (i >= len),
 * ParserError18 is thrown.
 * The JS string '* FETCH "test\\' represents the IMAP input: * FETCH "test\
 */
module.exports['Token Parser: E18: escape at end of quoted string throws ParserError18'] = test =>
    asyncWrapper(test, async test => {
        let err;
        try {
            await parser('* FETCH "test\\');
        } catch (e) {
            err = e;
        }
        if (!err) throw new Error('Expected parser to throw but it did not');
        test.ok(err, 'expected an error to be thrown');
        test.equal(err.code, 'ParserError18');
    });

/**
 * E23: Empty literal braces. When '}' is encountered in STATE_LITERAL before
 * any digit has been stored in literalLength, ParserError23 is thrown because
 * the check is: if (!('literalLength' in this.currentNode)) throw E23.
 */
module.exports['Token Parser: E23: empty literal braces throws ParserError23'] = test =>
    asyncWrapper(test, async test => {
        let err;
        try {
            await parser('* FETCH {}', { literals: [] });
        } catch (e) {
            err = e;
        }
        if (!err) throw new Error('Expected parser to throw but it did not');
        test.ok(err, 'expected an error to be thrown');
        test.equal(err.code, 'ParserError23');
    });

/**
 * E25: Non-digit character inside literal size braces. Any character inside
 * {…} that is not a digit (and not '}' or '+' with literalPlus) triggers
 * ParserError25.
 */
module.exports['Token Parser: E25: non-digit in literal size throws ParserError25'] = test =>
    asyncWrapper(test, async test => {
        let err;
        try {
            await parser('* FETCH {abc}', { literals: [] });
        } catch (e) {
            err = e;
        }
        if (!err) throw new Error('Expected parser to throw but it did not');
        test.ok(err, 'expected an error to be thrown');
        test.equal(err.code, 'ParserError25');
    });

/**
 * E26: Leading zero in literal size. After '0' is stored as literalLength,
 * any following digit triggers ParserError26 because a leading zero is invalid.
 */
module.exports['Token Parser: E26: leading zero in literal size throws ParserError26'] = test =>
    asyncWrapper(test, async test => {
        let err;
        try {
            await parser('* FETCH {01}', { literals: [Buffer.from('x')] });
        } catch (e) {
            err = e;
        }
        if (!err) throw new Error('Expected parser to throw but it did not');
        test.ok(err, 'expected an error to be thrown');
        test.equal(err.code, 'ParserError26');
    });

/**
 * MAX_IMAP_NESTING_REACHED: Nesting depth exceeds MAX_NODE_DEPTH (25).
 * createNode() throws when node.depth > 25. The root TREE node starts at
 * depth 0, so depth 1 is the first LIST ('('), and 26 open parens reaches
 * depth 26 which exceeds the limit.
 */
module.exports['Token Parser: MAX_IMAP_NESTING_REACHED: deep nesting throws MAX_IMAP_NESTING_REACHED'] = test =>
    asyncWrapper(test, async test => {
        let err;
        try {
            const depth = 26;
            const input = '* FETCH ' + '('.repeat(depth) + 'x' + ')'.repeat(depth);
            await parser(input);
        } catch (e) {
            err = e;
        }
        if (!err) throw new Error('Expected parser to throw but it did not');
        test.ok(err, 'expected an error to be thrown');
        test.equal(err.code, 'MAX_IMAP_NESTING_REACHED');
    });

// Happy-path tests

/**
 * NIL atom is returned as null in the attributes array. The ATOM node whose
 * value is "NIL" (case-insensitive) is converted to null in getAttributes().
 */
module.exports['Token Parser: NIL atom is parsed as null'] = test =>
    asyncWrapper(test, async test => {
        const result = await parser('* FETCH NIL');
        const attrs = result.attributes;
        test.ok(Array.isArray(attrs), 'attributes should be an array');
        test.equal(attrs.length, 1, 'should have exactly one attribute');
        test.strictEqual(attrs[0], null, 'NIL should be parsed as null');
    });

/**
 * Nested lists produce nested arrays in the attributes output.
 * Input ((a b)) produces: [ [ [ {a}, {b} ] ] ] — the attributes array contains
 * one outer list which contains one inner list with two atom elements.
 */
module.exports['Token Parser: nested lists produce nested arrays'] = test =>
    asyncWrapper(test, async test => {
        const result = await parser('* FETCH ((a b))');
        const attrs = result.attributes;
        test.ok(Array.isArray(attrs), 'attributes should be an array');
        const outer = attrs[0];
        test.ok(Array.isArray(outer), 'outer list should be an array');
        const inner = outer[0];
        test.ok(Array.isArray(inner), 'inner list should be an array');
        test.equal(inner.length, 2, 'inner list should have 2 elements');
        test.equal(inner[0].value, 'a', 'first inner element value should be a');
        test.equal(inner[1].value, 'b', 'second inner element value should be b');
    });

/**
 * Quoted string with escaped double-quote characters. The backslash-escape
 * mechanism converts \" to " in the parsed value. The JS literal
 * '* FETCH "hello \\"world\\""' represents: * FETCH "hello \"world\""
 */
module.exports['Token Parser: quoted string with escaped quotes is parsed correctly'] = test =>
    asyncWrapper(test, async test => {
        const result = await parser('* FETCH "hello \\"world\\""');
        const attrs = result.attributes;
        test.ok(Array.isArray(attrs), 'attributes should be an array');
        test.equal(attrs.length, 1, 'should have exactly one attribute');
        test.equal(attrs[0].type, 'STRING', 'type should be STRING');
        test.equal(attrs[0].value, 'hello "world"', 'escaped quotes should be unescaped');
    });

/**
 * Empty quoted string results in a STRING attribute with an empty value.
 */
module.exports['Token Parser: empty quoted string produces STRING with empty value'] = test =>
    asyncWrapper(test, async test => {
        const result = await parser('* FETCH ""');
        const attrs = result.attributes;
        test.ok(Array.isArray(attrs), 'attributes should be an array');
        test.equal(attrs.length, 1, 'should have exactly one attribute');
        test.equal(attrs[0].type, 'STRING', 'type should be STRING');
        test.equal(attrs[0].value, '', 'value should be empty string');
    });

/**
 * Literal data provided via the literals option is parsed into a LITERAL attribute.
 * When options.literals is set and '}' is encountered with a valid size, the next
 * Buffer in the literals array is used as the literal value directly.
 * The literal size in braces must be followed by \r\n or \n per IMAP protocol.
 */
module.exports['Token Parser: literal with pre-parsed data produces LITERAL attribute'] = test =>
    asyncWrapper(test, async test => {
        const data = Buffer.from('hello');
        const result = await parser('* FETCH {5}\r\n', { literals: [data] });
        const attrs = result.attributes;
        test.ok(Array.isArray(attrs), 'attributes should be an array');
        test.equal(attrs.length, 1, 'should have exactly one attribute');
        test.equal(attrs[0].type, 'LITERAL', 'type should be LITERAL');
        test.ok(Buffer.isBuffer(attrs[0].value), 'literal value should be a Buffer');
        test.equal(attrs[0].value.toString(), 'hello', 'literal value should match provided buffer');
    });

/**
 * A plain ATOM token produces an ATOM attribute with the correct string value.
 */
module.exports['Token Parser: atom value produces ATOM attribute'] = test =>
    asyncWrapper(test, async test => {
        const result = await parser('* FETCH INBOX');
        const attrs = result.attributes;
        test.ok(Array.isArray(attrs), 'attributes should be an array');
        test.equal(attrs.length, 1, 'should have exactly one attribute');
        test.equal(attrs[0].type, 'ATOM', 'type should be ATOM');
        test.equal(attrs[0].value, 'INBOX', 'value should be INBOX');
    });

/**
 * E29: Range separator ':' after a character that is not a digit or '*'.
 * Input "1,:5" starts as ATOM "1", ',' triggers SEQUENCE reclassification and
 * appends ',' (value becomes "1,"). Then ':' fires E29 because last char ','
 * is not a digit or '*'.
 */
module.exports['Token Parser: E29: range separator after non-digit/non-star throws ParserError29'] = test =>
    asyncWrapper(test, async test => {
        let err;
        try {
            await parser('* FETCH 1,:5');
        } catch (e) {
            err = e;
        }
        if (!err) throw new Error('Expected parser to throw but it did not');
        test.ok(err, 'expected an error to be thrown');
        test.equal(err.code, 'ParserError29');
    });

/**
 * E30: Wildcard '*' when last char is not ',' or ':'.
 * Input "1:2*" enters SEQUENCE after "1:" and appends "2" (value "1:2").
 * Then '*' fires E30 because last char '2' is not ',' or ':'.
 */
module.exports['Token Parser: E30: wildcard after digit throws ParserError30'] = test =>
    asyncWrapper(test, async test => {
        let err;
        try {
            await parser('* FETCH 1:2*');
        } catch (e) {
            err = e;
        }
        if (!err) throw new Error('Expected parser to throw but it did not');
        test.ok(err, 'expected an error to be thrown');
        test.equal(err.code, 'ParserError30');
    });

/**
 * E31: Separator ',' after a character that is not a digit or '*'.
 * Input "1:,5" enters SEQUENCE after "1" and appends ':' (value "1:").
 * Then ',' fires E31 because last char ':' is not a digit or '*'.
 */
module.exports['Token Parser: E31: comma after colon throws ParserError31'] = test =>
    asyncWrapper(test, async test => {
        let err;
        try {
            await parser('* FETCH 1:,5');
        } catch (e) {
            err = e;
        }
        if (!err) throw new Error('Expected parser to throw but it did not');
        test.ok(err, 'expected an error to be thrown');
        test.equal(err.code, 'ParserError31');
    });

/**
 * E32: Separator ',' after bare '*' (not in a range).
 * Input "*,5" starts SEQUENCE with value "*". Then ',' passes E31
 * (last char '*' satisfies the check) but fires E32 because last char
 * is '*' and the char before it (at(-2)) is not ':'.
 */
module.exports['Token Parser: E32: comma after bare star throws ParserError32'] = test =>
    asyncWrapper(test, async test => {
        let err;
        try {
            await parser('* FETCH *,5');
        } catch (e) {
            err = e;
        }
        if (!err) throw new Error('Expected parser to throw but it did not');
        test.ok(err, 'expected an error to be thrown');
        test.equal(err.code, 'ParserError32');
    });

/**
 * E33: Non-digit, non-special character in sequence position.
 * Input "1:a" enters SEQUENCE after "1" and appends ':' (value "1:").
 * Then 'a' is not a digit, not ':', not '*', not ',' so E33 fires.
 */
module.exports['Token Parser: E33: non-digit non-special char in sequence throws ParserError33'] = test =>
    asyncWrapper(test, async test => {
        let err;
        try {
            await parser('* FETCH 1:a');
        } catch (e) {
            err = e;
        }
        if (!err) throw new Error('Expected parser to throw but it did not');
        test.ok(err, 'expected an error to be thrown');
        test.equal(err.code, 'ParserError33');
    });

/**
 * E34: Digit immediately after '*'.
 * Input "*1" starts SEQUENCE with value "*". Then '1' is a digit but
 * last char is '*', so E34 fires (digits cannot follow '*').
 */
module.exports['Token Parser: E34: digit after star throws ParserError34'] = test =>
    asyncWrapper(test, async test => {
        let err;
        try {
            await parser('* FETCH *1');
        } catch (e) {
            err = e;
        }
        if (!err) throw new Error('Expected parser to throw but it did not');
        test.ok(err, 'expected an error to be thrown');
        test.equal(err.code, 'ParserError34');
    });
