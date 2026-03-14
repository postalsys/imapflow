'use strict';

const { resolveCharset } = require('../lib/charsets');

// ============================================
// Canonical name resolution
// ============================================

module.exports['Charsets: resolves canonical UTF-8'] = test => {
    test.equal(resolveCharset('UTF-8'), 'UTF-8');
    test.done();
};

module.exports['Charsets: resolves canonical ISO-8859-1'] = test => {
    test.equal(resolveCharset('ISO-8859-1'), 'ISO-8859-1');
    test.done();
};

module.exports['Charsets: resolves canonical windows-1252'] = test => {
    test.equal(resolveCharset('windows-1252'), 'windows-1252');
    test.done();
};

module.exports['Charsets: resolves canonical US-ASCII'] = test => {
    test.equal(resolveCharset('US-ASCII'), 'US-ASCII');
    test.done();
};

// ============================================
// Alias resolution
// ============================================

module.exports['Charsets: resolves utf8 alias to UTF-8'] = test => {
    test.equal(resolveCharset('utf8'), 'UTF-8');
    test.done();
};

module.exports['Charsets: resolves win1252 alias to windows-1252'] = test => {
    test.equal(resolveCharset('win1252'), 'windows-1252');
    test.done();
};

module.exports['Charsets: resolves latin1 alias to ISO-8859-1'] = test => {
    test.equal(resolveCharset('latin1'), 'ISO-8859-1');
    test.done();
};

module.exports['Charsets: resolves ascii alias to US-ASCII'] = test => {
    test.equal(resolveCharset('ascii'), 'US-ASCII');
    test.done();
};

module.exports['Charsets: resolves usascii alias to US-ASCII'] = test => {
    test.equal(resolveCharset('usascii'), 'US-ASCII');
    test.done();
};

// ============================================
// Case insensitivity
// ============================================

module.exports['Charsets: resolves lowercase utf-8 to UTF-8'] = test => {
    test.equal(resolveCharset('utf-8'), 'UTF-8');
    test.done();
};

module.exports['Charsets: resolves mixed-case Utf-8 to UTF-8'] = test => {
    test.equal(resolveCharset('Utf-8'), 'UTF-8');
    test.done();
};

module.exports['Charsets: resolves uppercase UTF8 (no separator) to UTF-8'] = test => {
    test.equal(resolveCharset('UTF8'), 'UTF-8');
    test.done();
};

// ============================================
// Separator stripping
// ============================================

module.exports['Charsets: resolves ISO_8859_1 (underscores) to ISO-8859-1'] = test => {
    test.equal(resolveCharset('ISO_8859_1'), 'ISO-8859-1');
    test.done();
};

module.exports['Charsets: resolves windows_1252 (underscores) to windows-1252'] = test => {
    test.equal(resolveCharset('windows_1252'), 'windows-1252');
    test.done();
};

// ============================================
// Japanese and CJK charsets
// ============================================

module.exports['Charsets: resolves ISO-2022-JP'] = test => {
    test.equal(resolveCharset('ISO-2022-JP'), 'ISO-2022-JP');
    test.done();
};

module.exports['Charsets: resolves Shift_JIS'] = test => {
    test.equal(resolveCharset('Shift_JIS'), 'Shift_JIS');
    test.done();
};

module.exports['Charsets: resolves EUC-JP'] = test => {
    test.equal(resolveCharset('EUC-JP'), 'EUC-JP');
    test.done();
};

module.exports['Charsets: resolves EUC-KR'] = test => {
    test.equal(resolveCharset('EUC-KR'), 'EUC-KR');
    test.done();
};

module.exports['Charsets: resolves GB2312'] = test => {
    test.equal(resolveCharset('GB2312'), 'GB2312');
    test.done();
};

module.exports['Charsets: resolves Big5'] = test => {
    test.equal(resolveCharset('Big5'), 'Big5');
    test.done();
};

module.exports['Charsets: resolves GBK'] = test => {
    test.equal(resolveCharset('GBK'), 'GBK');
    test.done();
};

// ============================================
// Unknown charsets return null
// ============================================

module.exports['Charsets: returns null for unknown charset x-unknown'] = test => {
    test.strictEqual(resolveCharset('x-unknown'), null);
    test.done();
};

module.exports['Charsets: returns null for unknown charset bogus'] = test => {
    test.strictEqual(resolveCharset('bogus'), null);
    test.done();
};

module.exports['Charsets: returns null for empty string'] = test => {
    test.strictEqual(resolveCharset(''), null);
    test.done();
};

// ============================================
// Invalid input throws TypeError
// ============================================

module.exports['Charsets: throws TypeError for null input'] = test => {
    test.throws(() => resolveCharset(null));
    test.done();
};

module.exports['Charsets: throws TypeError for undefined input'] = test => {
    test.throws(() => resolveCharset(undefined));
    test.done();
};
