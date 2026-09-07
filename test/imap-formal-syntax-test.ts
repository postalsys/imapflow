/* eslint new-cap: 0 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import imapFormalSyntax from '../src/handler/imap-formal-syntax.js';

describe('imap-formal-syntax', () => {
    // ---------------------------------------------------------------------------
    // CHAR
    // ---------------------------------------------------------------------------
    it('Formal Syntax: CHAR() has length 127', () => {
        assert.equal(imapFormalSyntax.CHAR().length, 127);
    });
    it('Formal Syntax: CHAR() includes A', () => {
        assert.ok(imapFormalSyntax.CHAR().includes('A'));
    });
    it('Formal Syntax: CHAR() excludes NUL (0x00)', () => {
        assert.ok(!imapFormalSyntax.CHAR().includes('\x00'));
    });
    it('Formal Syntax: CHAR() excludes 0x80', () => {
        assert.ok(!imapFormalSyntax.CHAR().includes('\x80'));
    });

    // ---------------------------------------------------------------------------
    // CHAR8
    // ---------------------------------------------------------------------------
    it('Formal Syntax: CHAR8() has length 255', () => {
        assert.equal(imapFormalSyntax.CHAR8().length, 255);
    });
    it('Formal Syntax: CHAR8() includes 0xFF', () => {
        assert.ok(imapFormalSyntax.CHAR8().includes('\xFF'));
    });

    // ---------------------------------------------------------------------------
    // SP
    // ---------------------------------------------------------------------------
    it('Formal Syntax: SP() equals a single space', () => {
        assert.equal(imapFormalSyntax.SP(), ' ');
    });
    it('Formal Syntax: SP() has length 1', () => {
        assert.equal(imapFormalSyntax.SP().length, 1);
    });

    // ---------------------------------------------------------------------------
    // CTL
    // ---------------------------------------------------------------------------
    it('Formal Syntax: CTL() includes NUL (0x00)', () => {
        assert.ok(imapFormalSyntax.CTL().includes('\x00'));
    });
    it('Formal Syntax: CTL() includes 0x1F', () => {
        assert.ok(imapFormalSyntax.CTL().includes('\x1F'));
    });
    it('Formal Syntax: CTL() includes DEL (0x7F)', () => {
        assert.ok(imapFormalSyntax.CTL().includes('\x7F'));
    });
    it('Formal Syntax: CTL() excludes space (0x20)', () => {
        assert.ok(!imapFormalSyntax.CTL().includes(' '));
    });

    // ---------------------------------------------------------------------------
    // ALPHA
    // ---------------------------------------------------------------------------
    it('Formal Syntax: ALPHA() has length 52', () => {
        assert.equal(imapFormalSyntax.ALPHA().length, 52);
    });
    it('Formal Syntax: ALPHA() includes A', () => {
        assert.ok(imapFormalSyntax.ALPHA().includes('A'));
    });
    it('Formal Syntax: ALPHA() includes z', () => {
        assert.ok(imapFormalSyntax.ALPHA().includes('z'));
    });
    it('Formal Syntax: ALPHA() excludes 0', () => {
        assert.ok(!imapFormalSyntax.ALPHA().includes('0'));
    });

    // ---------------------------------------------------------------------------
    // DIGIT
    // ---------------------------------------------------------------------------
    it('Formal Syntax: DIGIT() has length 10', () => {
        assert.equal(imapFormalSyntax.DIGIT().length, 10);
    });
    it('Formal Syntax: DIGIT() includes 0', () => {
        assert.ok(imapFormalSyntax.DIGIT().includes('0'));
    });
    it('Formal Syntax: DIGIT() includes 9', () => {
        assert.ok(imapFormalSyntax.DIGIT().includes('9'));
    });
    it('Formal Syntax: DIGIT() excludes a', () => {
        assert.ok(!imapFormalSyntax.DIGIT().includes('a'));
    });

    // ---------------------------------------------------------------------------
    // ATOM-CHAR
    // ---------------------------------------------------------------------------
    it('Formal Syntax: ATOM-CHAR() includes A', () => {
        assert.ok(imapFormalSyntax['ATOM-CHAR']().includes('A'));
    });
    it('Formal Syntax: ATOM-CHAR() excludes open paren', () => {
        assert.ok(!imapFormalSyntax['ATOM-CHAR']().includes('('));
    });
    it('Formal Syntax: ATOM-CHAR() excludes close paren', () => {
        assert.ok(!imapFormalSyntax['ATOM-CHAR']().includes(')'));
    });
    it('Formal Syntax: ATOM-CHAR() excludes open brace', () => {
        assert.ok(!imapFormalSyntax['ATOM-CHAR']().includes('{'));
    });
    it('Formal Syntax: ATOM-CHAR() excludes space', () => {
        assert.ok(!imapFormalSyntax['ATOM-CHAR']().includes(' '));
    });
    it('Formal Syntax: ATOM-CHAR() excludes double quote', () => {
        assert.ok(!imapFormalSyntax['ATOM-CHAR']().includes('"'));
    });
    it('Formal Syntax: ATOM-CHAR() excludes backslash', () => {
        assert.ok(!imapFormalSyntax['ATOM-CHAR']().includes('\\'));
    });

    // ---------------------------------------------------------------------------
    // ASTRING-CHAR
    // ---------------------------------------------------------------------------
    it('Formal Syntax: ASTRING-CHAR() includes close bracket (resp-special)', () => {
        assert.ok(imapFormalSyntax['ASTRING-CHAR']().includes(']'));
    });

    // ---------------------------------------------------------------------------
    // TEXT-CHAR
    // ---------------------------------------------------------------------------
    it('Formal Syntax: TEXT-CHAR() includes A', () => {
        assert.ok(imapFormalSyntax['TEXT-CHAR']().includes('A'));
    });
    it('Formal Syntax: TEXT-CHAR() includes space', () => {
        assert.ok(imapFormalSyntax['TEXT-CHAR']().includes(' '));
    });
    it('Formal Syntax: TEXT-CHAR() excludes CR', () => {
        assert.ok(!imapFormalSyntax['TEXT-CHAR']().includes('\r'));
    });
    it('Formal Syntax: TEXT-CHAR() excludes LF', () => {
        assert.ok(!imapFormalSyntax['TEXT-CHAR']().includes('\n'));
    });

    // ---------------------------------------------------------------------------
    // tag
    // ---------------------------------------------------------------------------
    it('Formal Syntax: tag() excludes plus sign', () => {
        assert.ok(!imapFormalSyntax.tag().includes('+'));
    });
    it('Formal Syntax: tag() includes A', () => {
        assert.ok(imapFormalSyntax.tag().includes('A'));
    });
    it('Formal Syntax: tag() includes close bracket', () => {
        assert.ok(imapFormalSyntax.tag().includes(']'));
    });

    // ---------------------------------------------------------------------------
    // command
    // ---------------------------------------------------------------------------
    it('Formal Syntax: command() includes A', () => {
        assert.ok(imapFormalSyntax.command().includes('A'));
    });
    it('Formal Syntax: command() includes 0', () => {
        assert.ok(imapFormalSyntax.command().includes('0'));
    });
    it('Formal Syntax: command() includes hyphen', () => {
        assert.ok(imapFormalSyntax.command().includes('-'));
    });
    it('Formal Syntax: command() excludes asterisk', () => {
        assert.ok(!imapFormalSyntax.command().includes('*'));
    });

    // ---------------------------------------------------------------------------
    // verify()
    // ---------------------------------------------------------------------------
    it('Formal Syntax: verify() returns -1 when all characters are valid', () => {
        assert.equal(imapFormalSyntax.verify('ABC', 'ABCDEF'), -1);
    });
    it('Formal Syntax: verify() returns index of first invalid character', () => {
        assert.equal(imapFormalSyntax.verify('ABXC', 'ABC'), 2);
    });
    it('Formal Syntax: verify() returns 0 when first character is invalid', () => {
        assert.equal(imapFormalSyntax.verify('!A', 'ABC'), 0);
    });

    // ---------------------------------------------------------------------------
    // Memoization
    // ---------------------------------------------------------------------------
    it('Formal Syntax: CHAR() returns same string reference on repeated calls (memoized)', () => {
        // After the first call, the method is replaced with a closure that returns
        // the cached value, so subsequent calls must return the exact same string object.
        const first = imapFormalSyntax.CHAR();
        const second = imapFormalSyntax.CHAR();
        assert.strictEqual(first, second);
    });

    // Memoization: the second invocation must return the cached value via the
    // rewritten getter (covers the memoized inner functions).
    it('Formal Syntax: atom-specials is memoized across calls', () => {
        let first = imapFormalSyntax['atom-specials']();
        let second = imapFormalSyntax['atom-specials']();
        assert.equal(first, second);
        assert.ok(second.includes('('));
    });
    it('Formal Syntax: quoted-specials is memoized across calls', () => {
        let first = imapFormalSyntax['quoted-specials']();
        let second = imapFormalSyntax['quoted-specials']();
        assert.equal(first, second);
        assert.ok(second.includes('"'));
    });
});
