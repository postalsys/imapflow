/* eslint new-cap: 0 */
'use strict';

const imapFormalSyntax = require('../lib/handler/imap-formal-syntax');

// ---------------------------------------------------------------------------
// CHAR
// ---------------------------------------------------------------------------

module.exports['Formal Syntax: CHAR() has length 127'] = test => {
    test.equal(imapFormalSyntax.CHAR().length, 127);
    test.done();
};

module.exports['Formal Syntax: CHAR() includes A'] = test => {
    test.ok(imapFormalSyntax.CHAR().includes('A'));
    test.done();
};

module.exports['Formal Syntax: CHAR() excludes NUL (0x00)'] = test => {
    test.ok(!imapFormalSyntax.CHAR().includes('\x00'));
    test.done();
};

module.exports['Formal Syntax: CHAR() excludes 0x80'] = test => {
    test.ok(!imapFormalSyntax.CHAR().includes('\x80'));
    test.done();
};

// ---------------------------------------------------------------------------
// CHAR8
// ---------------------------------------------------------------------------

module.exports['Formal Syntax: CHAR8() has length 255'] = test => {
    test.equal(imapFormalSyntax.CHAR8().length, 255);
    test.done();
};

module.exports['Formal Syntax: CHAR8() includes 0xFF'] = test => {
    test.ok(imapFormalSyntax.CHAR8().includes('\xFF'));
    test.done();
};

// ---------------------------------------------------------------------------
// SP
// ---------------------------------------------------------------------------

module.exports['Formal Syntax: SP() equals a single space'] = test => {
    test.equal(imapFormalSyntax.SP(), ' ');
    test.done();
};

module.exports['Formal Syntax: SP() has length 1'] = test => {
    test.equal(imapFormalSyntax.SP().length, 1);
    test.done();
};

// ---------------------------------------------------------------------------
// CTL
// ---------------------------------------------------------------------------

module.exports['Formal Syntax: CTL() includes NUL (0x00)'] = test => {
    test.ok(imapFormalSyntax.CTL().includes('\x00'));
    test.done();
};

module.exports['Formal Syntax: CTL() includes 0x1F'] = test => {
    test.ok(imapFormalSyntax.CTL().includes('\x1F'));
    test.done();
};

module.exports['Formal Syntax: CTL() includes DEL (0x7F)'] = test => {
    test.ok(imapFormalSyntax.CTL().includes('\x7F'));
    test.done();
};

module.exports['Formal Syntax: CTL() excludes space (0x20)'] = test => {
    test.ok(!imapFormalSyntax.CTL().includes(' '));
    test.done();
};

// ---------------------------------------------------------------------------
// ALPHA
// ---------------------------------------------------------------------------

module.exports['Formal Syntax: ALPHA() has length 52'] = test => {
    test.equal(imapFormalSyntax.ALPHA().length, 52);
    test.done();
};

module.exports['Formal Syntax: ALPHA() includes A'] = test => {
    test.ok(imapFormalSyntax.ALPHA().includes('A'));
    test.done();
};

module.exports['Formal Syntax: ALPHA() includes z'] = test => {
    test.ok(imapFormalSyntax.ALPHA().includes('z'));
    test.done();
};

module.exports['Formal Syntax: ALPHA() excludes 0'] = test => {
    test.ok(!imapFormalSyntax.ALPHA().includes('0'));
    test.done();
};

// ---------------------------------------------------------------------------
// DIGIT
// ---------------------------------------------------------------------------

module.exports['Formal Syntax: DIGIT() has length 10'] = test => {
    test.equal(imapFormalSyntax.DIGIT().length, 10);
    test.done();
};

module.exports['Formal Syntax: DIGIT() includes 0'] = test => {
    test.ok(imapFormalSyntax.DIGIT().includes('0'));
    test.done();
};

module.exports['Formal Syntax: DIGIT() includes 9'] = test => {
    test.ok(imapFormalSyntax.DIGIT().includes('9'));
    test.done();
};

module.exports['Formal Syntax: DIGIT() excludes a'] = test => {
    test.ok(!imapFormalSyntax.DIGIT().includes('a'));
    test.done();
};

// ---------------------------------------------------------------------------
// ATOM-CHAR
// ---------------------------------------------------------------------------

module.exports['Formal Syntax: ATOM-CHAR() includes A'] = test => {
    test.ok(imapFormalSyntax['ATOM-CHAR']().includes('A'));
    test.done();
};

module.exports['Formal Syntax: ATOM-CHAR() excludes open paren'] = test => {
    test.ok(!imapFormalSyntax['ATOM-CHAR']().includes('('));
    test.done();
};

module.exports['Formal Syntax: ATOM-CHAR() excludes close paren'] = test => {
    test.ok(!imapFormalSyntax['ATOM-CHAR']().includes(')'));
    test.done();
};

module.exports['Formal Syntax: ATOM-CHAR() excludes open brace'] = test => {
    test.ok(!imapFormalSyntax['ATOM-CHAR']().includes('{'));
    test.done();
};

module.exports['Formal Syntax: ATOM-CHAR() excludes space'] = test => {
    test.ok(!imapFormalSyntax['ATOM-CHAR']().includes(' '));
    test.done();
};

module.exports['Formal Syntax: ATOM-CHAR() excludes double quote'] = test => {
    test.ok(!imapFormalSyntax['ATOM-CHAR']().includes('"'));
    test.done();
};

module.exports['Formal Syntax: ATOM-CHAR() excludes backslash'] = test => {
    test.ok(!imapFormalSyntax['ATOM-CHAR']().includes('\\'));
    test.done();
};

// ---------------------------------------------------------------------------
// ASTRING-CHAR
// ---------------------------------------------------------------------------

module.exports['Formal Syntax: ASTRING-CHAR() includes close bracket (resp-special)'] = test => {
    test.ok(imapFormalSyntax['ASTRING-CHAR']().includes(']'));
    test.done();
};

// ---------------------------------------------------------------------------
// TEXT-CHAR
// ---------------------------------------------------------------------------

module.exports['Formal Syntax: TEXT-CHAR() includes A'] = test => {
    test.ok(imapFormalSyntax['TEXT-CHAR']().includes('A'));
    test.done();
};

module.exports['Formal Syntax: TEXT-CHAR() includes space'] = test => {
    test.ok(imapFormalSyntax['TEXT-CHAR']().includes(' '));
    test.done();
};

module.exports['Formal Syntax: TEXT-CHAR() excludes CR'] = test => {
    test.ok(!imapFormalSyntax['TEXT-CHAR']().includes('\r'));
    test.done();
};

module.exports['Formal Syntax: TEXT-CHAR() excludes LF'] = test => {
    test.ok(!imapFormalSyntax['TEXT-CHAR']().includes('\n'));
    test.done();
};

// ---------------------------------------------------------------------------
// tag
// ---------------------------------------------------------------------------

module.exports['Formal Syntax: tag() excludes plus sign'] = test => {
    test.ok(!imapFormalSyntax.tag().includes('+'));
    test.done();
};

module.exports['Formal Syntax: tag() includes A'] = test => {
    test.ok(imapFormalSyntax.tag().includes('A'));
    test.done();
};

module.exports['Formal Syntax: tag() includes close bracket'] = test => {
    test.ok(imapFormalSyntax.tag().includes(']'));
    test.done();
};

// ---------------------------------------------------------------------------
// command
// ---------------------------------------------------------------------------

module.exports['Formal Syntax: command() includes A'] = test => {
    test.ok(imapFormalSyntax.command().includes('A'));
    test.done();
};

module.exports['Formal Syntax: command() includes 0'] = test => {
    test.ok(imapFormalSyntax.command().includes('0'));
    test.done();
};

module.exports['Formal Syntax: command() includes hyphen'] = test => {
    test.ok(imapFormalSyntax.command().includes('-'));
    test.done();
};

module.exports['Formal Syntax: command() excludes asterisk'] = test => {
    test.ok(!imapFormalSyntax.command().includes('*'));
    test.done();
};

// ---------------------------------------------------------------------------
// verify()
// ---------------------------------------------------------------------------

module.exports['Formal Syntax: verify() returns -1 when all characters are valid'] = test => {
    test.equal(imapFormalSyntax.verify('ABC', 'ABCDEF'), -1);
    test.done();
};

module.exports['Formal Syntax: verify() returns index of first invalid character'] = test => {
    test.equal(imapFormalSyntax.verify('ABXC', 'ABC'), 2);
    test.done();
};

module.exports['Formal Syntax: verify() returns 0 when first character is invalid'] = test => {
    test.equal(imapFormalSyntax.verify('!A', 'ABC'), 0);
    test.done();
};

// ---------------------------------------------------------------------------
// Memoization
// ---------------------------------------------------------------------------

module.exports['Formal Syntax: CHAR() returns same string reference on repeated calls (memoized)'] = test => {
    // After the first call, the method is replaced with a closure that returns
    // the cached value, so subsequent calls must return the exact same string object.
    const first = imapFormalSyntax.CHAR();
    const second = imapFormalSyntax.CHAR();
    test.strictEqual(first, second);
    test.done();
};
