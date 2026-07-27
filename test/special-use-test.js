'use strict';

const specialUse = require('../lib/special-use');

module.exports['Special Use: flags array'] = test => {
    test.ok(Array.isArray(specialUse.flags));
    test.ok(specialUse.flags.includes('\\Sent'));
    test.ok(specialUse.flags.includes('\\Drafts'));
    test.ok(specialUse.flags.includes('\\Trash'));
    test.ok(specialUse.flags.includes('\\Archive'));
    test.done();
};

module.exports['Special Use: names object'] = test => {
    test.ok(typeof specialUse.names === 'object');
    test.ok(specialUse.names['\\Sent']);
    test.ok(Array.isArray(specialUse.names['\\Sent']));
    test.ok(specialUse.names['\\Sent'].includes('sent'));
    test.done();
};

module.exports['Special Use: Sent folder names'] = test => {
    let sentNames = specialUse.names['\\Sent'];
    test.ok(sentNames.includes('sent'));
    test.ok(sentNames.includes('sent items'));
    test.ok(sentNames.includes('sent messages'));
    test.done();
};

module.exports['Special Use: Drafts folder names'] = test => {
    let draftsNames = specialUse.names['\\Drafts'];
    test.ok(draftsNames.includes('drafts'));
    test.done();
};

module.exports['Special Use: Trash folder names'] = test => {
    let trashNames = specialUse.names['\\Trash'];
    test.ok(trashNames.includes('trash'));
    test.ok(trashNames.includes('deleted items'));
    test.ok(trashNames.includes('deleted messages'));
    test.done();
};

module.exports['Special Use: Junk folder names'] = test => {
    let junkNames = specialUse.names['\\Junk'];
    test.ok(junkNames.includes('spam'));
    test.ok(junkNames.includes('junk'));
    test.done();
};

// ============================================
// specialUse() function branch tests
// ============================================

module.exports['Special Use: specialUse returns extension flag when extension enabled and flag found'] = test => {
    const result = specialUse.specialUse(true, { flags: new Set(['\\Sent']), name: 'Foo' });
    test.equal(result.flag, '\\Sent');
    test.equal(result.source, 'extension');
    test.done();
};

module.exports['Special Use: specialUse falls back to name when extension enabled but no flag'] = test => {
    const result = specialUse.specialUse(true, { flags: new Set(), name: 'Sent' });
    test.equal(result.flag, '\\Sent');
    test.equal(result.source, 'name');
    test.done();
};

module.exports['Special Use: specialUse matches by name when extension disabled'] = test => {
    const result = specialUse.specialUse(false, { flags: new Set(), name: 'Drafts' });
    test.equal(result.flag, '\\Drafts');
    test.equal(result.source, 'name');
    test.done();
};

module.exports['Special Use: specialUse returns null flag when no match'] = test => {
    const result = specialUse.specialUse(false, { flags: new Set(), name: 'CustomFolder' });
    test.equal(result.flag, null);
    test.equal(result.source, undefined);
    test.done();
};

// ============================================
// Localized folder name detection
// ============================================

// Helper: resolve a folder name the way a server without SPECIAL-USE would be handled.
const byName = name => specialUse.specialUse(false, { flags: new Set(), name }).flag;

// Regression: Exchange/Outlook does not advertise SPECIAL-USE, so a Russian-locale
// mailbox has to resolve purely by folder name. Junk and Archive used to fall through.
module.exports['Special Use: Russian Outlook mailbox resolves every special-use folder'] = test => {
    test.equal(byName('Отправленные'), '\\Sent');
    test.equal(byName('Черновики'), '\\Drafts');
    test.equal(byName('Удаленные'), '\\Trash');
    test.equal(byName('Нежелательная почта'), '\\Junk');
    test.equal(byName('Архив'), '\\Archive');
    test.done();
};

// Non-mail folders exposed over IMAP by Exchange must stay unclassified.
module.exports['Special Use: Russian calendar and contacts folders stay unmatched'] = test => {
    test.equal(byName('Календарь'), null);
    test.equal(byName('Контакты'), null);
    test.done();
};

// Russian webmail (Yandex, Mail.ru, Rambler) uses different words than Outlook.
module.exports['Special Use: Russian webmail folder names'] = test => {
    test.equal(byName('Корзина'), '\\Trash');
    test.equal(byName('Удалённые'), '\\Trash'); // spelled with a real "ё"
    test.equal(byName('Спам'), '\\Junk');
    test.done();
};

module.exports['Special Use: Archive folder names across locales'] = test => {
    test.equal(byName('Archive'), '\\Archive');
    test.equal(byName('Архив'), '\\Archive');
    test.equal(byName('Архів'), '\\Archive');
    test.equal(byName('Archiv'), '\\Archive');
    test.equal(byName('Archivo'), '\\Archive');
    test.equal(byName('Arquivo'), '\\Archive');
    test.equal(byName('Archivio'), '\\Archive');
    test.equal(byName('Archief'), '\\Archive');
    test.equal(byName('Arkiv'), '\\Archive');
    test.equal(byName('Arşiv'), '\\Archive');
    test.equal(byName('アーカイブ'), '\\Archive');
    test.equal(byName('보관함'), '\\Archive');
    test.done();
};

module.exports['Special Use: Junk folder names across locales'] = test => {
    test.equal(byName('Junk Email'), '\\Junk');
    test.equal(byName('Нежелательная почта'), '\\Junk');
    test.equal(byName('Небажана пошта'), '\\Junk');
    test.equal(byName('Ongewenste e-mail'), '\\Junk');
    test.equal(byName('Lixo Eletrônico'), '\\Junk');
    test.equal(byName('Neželjena pošta'), '\\Junk');
    test.equal(byName('迷惑メール'), '\\Junk');
    test.equal(byName('정크 메일'), '\\Junk');
    test.done();
};

module.exports['Special Use: Trash folder names across locales'] = test => {
    test.equal(byName('Deleted Items'), '\\Trash');
    test.equal(byName('Corbeille'), '\\Trash');
    test.equal(byName('Papierkorb'), '\\Trash');
    test.equal(byName('Papelera'), '\\Trash');
    test.equal(byName('Cestino'), '\\Trash');
    test.equal(byName('Kosz'), '\\Trash');
    test.equal(byName('ゴミ箱'), '\\Trash');
    test.equal(byName('휴지통'), '\\Trash');
    test.done();
};

// Matching lowercases the folder name, so non-ASCII scripts must fold too.
module.exports['Special Use: name matching is case insensitive for non-ASCII names'] = test => {
    test.equal(byName('НЕЖЕЛАТЕЛЬНАЯ ПОЧТА'), '\\Junk');
    test.equal(byName('АРХИВ'), '\\Archive');
    test.equal(byName('Корзина'), '\\Trash');
    test.done();
};

// Surrounding whitespace and the LTR mark injected by some clients are stripped.
module.exports['Special Use: strips whitespace and LTR marks before matching'] = test => {
    test.equal(byName('  Архив  '), '\\Archive');
    test.equal(byName('\u200eНежелательная почта'), '\\Junk');
    test.done();
};

// ============================================
// Structural guards for the name tables
// ============================================

// A name listed under two different flags would make detection depend on key order.
module.exports['Special Use: no folder name is claimed by two flags'] = test => {
    let owner = new Map();
    let collisions = [];
    for (let flag of Object.keys(specialUse.names)) {
        for (let name of specialUse.names[flag]) {
            if (owner.has(name) && owner.get(name) !== flag) {
                collisions.push(`${name}: ${owner.get(name)} vs ${flag}`);
            }
            owner.set(name, flag);
        }
    }
    test.deepEqual(collisions, []);
    test.done();
};

// Lookups normalize the incoming name to NFC, so an entry stored in any other
// normalization form can never match, however the server spells the folder.
module.exports['Special Use: every name entry is stored in NFC form'] = test => {
    let problems = [];
    for (let flag of Object.keys(specialUse.names)) {
        for (let name of specialUse.names[flag]) {
            if (name !== name.normalize('NFC')) {
                problems.push(`${flag}: not NFC: ${name}`);
            }
        }
    }
    test.deepEqual(problems, []);
    test.done();
};

// Servers echo back whatever normalization form the creating client used, so both
// canonically equivalent spellings of a name must resolve to the same flag.
module.exports['Special Use: matching is independent of Unicode normalization form'] = test => {
    let mismatches = [];
    for (let flag of Object.keys(specialUse.names)) {
        for (let name of specialUse.names[flag]) {
            for (let form of ['NFC', 'NFD']) {
                let resolved = specialUse.specialUse(false, { flags: new Set(), name: name.normalize(form) }).flag;
                if (resolved !== flag) {
                    mismatches.push(`${flag}: "${name}" as ${form} resolved to ${resolved}`);
                }
            }
        }
    }
    test.deepEqual(mismatches, []);
    test.done();
};

// Devanagari and Bengali nukta letters are Unicode composition exclusions: the
// precomposed character is NOT the NFC form, so these two entries used to match
// only if the server happened to send the precomposed spelling.
module.exports['Special Use: nukta drafts folders match in either spelling'] = test => {
    // U+095E DEVANAGARI LETTER PHA WITH NUKTA vs U+092B U+093C
    const hindi = String.fromCodePoint(0x0921, 0x094d, 0x0930, 0x093e, 0x095e, 0x094d, 0x091f);
    // U+09DC BENGALI LETTER RRA vs U+09A1 U+09BC
    const bengali = String.fromCodePoint(0x0996, 0x09b8, 0x09dc, 0x09be);

    test.equal(byName(hindi), '\\Drafts');
    test.equal(byName(hindi.normalize('NFC')), '\\Drafts');
    test.equal(byName(bengali), '\\Drafts');
    test.equal(byName(bengali.normalize('NFC')), '\\Drafts');
    test.done();
};

// Lookups compare against a lowercased and trimmed name, so entries stored in any
// other form are dead weight that can never match.
module.exports['Special Use: every name entry is lowercase, trimmed and unique'] = test => {
    let problems = [];
    for (let flag of Object.keys(specialUse.names)) {
        let seen = new Set();
        for (let name of specialUse.names[flag]) {
            if (name !== name.toLowerCase()) {
                problems.push(`${flag}: not lowercase: ${name}`);
            }
            if (name !== name.trim()) {
                problems.push(`${flag}: not trimmed: ${JSON.stringify(name)}`);
            }
            if (seen.has(name)) {
                problems.push(`${flag}: duplicate: ${name}`);
            }
            seen.add(name);
        }
    }
    test.deepEqual(problems, []);
    test.done();
};
