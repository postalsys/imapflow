import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCharset } from '../src/charsets.js';

describe('charsets', () => {
    // ============================================
    // Canonical name resolution
    // ============================================
    it('Charsets: resolves canonical UTF-8', () => {
        assert.equal(resolveCharset('UTF-8'), 'UTF-8');
    });
    it('Charsets: resolves canonical ISO-8859-1', () => {
        assert.equal(resolveCharset('ISO-8859-1'), 'ISO-8859-1');
    });
    it('Charsets: resolves canonical windows-1252', () => {
        assert.equal(resolveCharset('windows-1252'), 'windows-1252');
    });
    it('Charsets: resolves canonical US-ASCII', () => {
        assert.equal(resolveCharset('US-ASCII'), 'US-ASCII');
    });

    // ============================================
    // Alias resolution
    // ============================================
    it('Charsets: resolves utf8 alias to UTF-8', () => {
        assert.equal(resolveCharset('utf8'), 'UTF-8');
    });
    it('Charsets: resolves win1252 alias to windows-1252', () => {
        assert.equal(resolveCharset('win1252'), 'windows-1252');
    });
    it('Charsets: resolves latin1 alias to ISO-8859-1', () => {
        assert.equal(resolveCharset('latin1'), 'ISO-8859-1');
    });
    it('Charsets: resolves ascii alias to US-ASCII', () => {
        assert.equal(resolveCharset('ascii'), 'US-ASCII');
    });
    it('Charsets: resolves usascii alias to US-ASCII', () => {
        assert.equal(resolveCharset('usascii'), 'US-ASCII');
    });

    // ============================================
    // Case insensitivity
    // ============================================
    it('Charsets: resolves lowercase utf-8 to UTF-8', () => {
        assert.equal(resolveCharset('utf-8'), 'UTF-8');
    });
    it('Charsets: resolves mixed-case Utf-8 to UTF-8', () => {
        assert.equal(resolveCharset('Utf-8'), 'UTF-8');
    });
    it('Charsets: resolves uppercase UTF8 (no separator) to UTF-8', () => {
        assert.equal(resolveCharset('UTF8'), 'UTF-8');
    });

    // ============================================
    // Separator stripping
    // ============================================
    it('Charsets: resolves ISO_8859_1 (underscores) to ISO-8859-1', () => {
        assert.equal(resolveCharset('ISO_8859_1'), 'ISO-8859-1');
    });
    it('Charsets: resolves windows_1252 (underscores) to windows-1252', () => {
        assert.equal(resolveCharset('windows_1252'), 'windows-1252');
    });

    // ============================================
    // Japanese and CJK charsets
    // ============================================
    it('Charsets: resolves ISO-2022-JP', () => {
        assert.equal(resolveCharset('ISO-2022-JP'), 'ISO-2022-JP');
    });
    it('Charsets: resolves Shift_JIS', () => {
        assert.equal(resolveCharset('Shift_JIS'), 'Shift_JIS');
    });
    it('Charsets: resolves EUC-JP', () => {
        assert.equal(resolveCharset('EUC-JP'), 'EUC-JP');
    });
    it('Charsets: resolves EUC-KR', () => {
        assert.equal(resolveCharset('EUC-KR'), 'EUC-KR');
    });
    it('Charsets: resolves GB2312', () => {
        assert.equal(resolveCharset('GB2312'), 'GB2312');
    });
    it('Charsets: resolves Big5', () => {
        assert.equal(resolveCharset('Big5'), 'Big5');
    });
    it('Charsets: resolves GBK', () => {
        assert.equal(resolveCharset('GBK'), 'GBK');
    });

    // ============================================
    // Unknown charsets return null
    // ============================================
    it('Charsets: returns null for unknown charset x-unknown', () => {
        assert.strictEqual(resolveCharset('x-unknown'), null);
    });
    it('Charsets: returns null for unknown charset bogus', () => {
        assert.strictEqual(resolveCharset('bogus'), null);
    });
    it('Charsets: returns null for empty string', () => {
        assert.strictEqual(resolveCharset(''), null);
    });

    // ============================================
    // Invalid input throws TypeError
    // ============================================
    it('Charsets: throws TypeError for null input', () => {
        assert.throws(() => resolveCharset(null as any));
    });
    it('Charsets: throws TypeError for undefined input', () => {
        assert.throws(() => resolveCharset(undefined as any));
    });
});
