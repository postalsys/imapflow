'use strict';

const specialUse = require('../lib/special-use');
const fs = require('fs');

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

// Exchange and Outlook use a two word naming style ("Sent Items") that differs from
// the one word style most webmail uses ("Sent"), and they never advertise SPECIAL-USE,
// so these names have to resolve by name alone.
module.exports['Special Use: Exchange and Outlook localized folder names'] = test => {
    test.equal(byName('Sent Items'), '\\Sent');
    test.equal(byName('Deleted Items'), '\\Trash');
    test.equal(byName('Junk Email'), '\\Junk');
    test.equal(byName('Gesendete Elemente'), '\\Sent');
    test.equal(byName('Gelöschte Elemente'), '\\Trash');
    test.equal(byName('Éléments envoyés'), '\\Sent');
    test.equal(byName('Elementos eliminados'), '\\Trash');
    test.equal(byName('Posta eliminata'), '\\Trash');
    test.equal(byName('Verzonden items'), '\\Sent');
    test.equal(byName('Elementy usunięte'), '\\Trash');
    test.equal(byName('Elemente șterse'), '\\Trash');
    test.equal(byName('Sendte elementer'), '\\Sent');
    test.equal(byName('Gönderilmiş Öğeler'), '\\Sent');
    test.equal(byName('Önemsiz E-posta'), '\\Junk');
    test.equal(byName('送信済みアイテム'), '\\Sent');
    test.equal(byName('削除済みアイテム'), '\\Trash');
    test.equal(byName('보낸 편지함'), '\\Sent');
    test.done();
};

// Names harvested from the localization catalogs of Roundcube, SOGo and Thunderbird.
// These are the cases that motivated, and are now covered without, approximate matching.
module.exports['Special Use: names taken from mail client localization catalogs'] = test => {
    test.equal(byName('Gesendet'), '\\Sent'); // de, Thunderbird
    test.equal(byName('Skickat'), '\\Sent'); // sv
    test.equal(byName('Gelöscht'), '\\Trash'); // de, Roundcube
    test.equal(byName('Poubelle'), '\\Trash'); // fr
    test.equal(byName('Paperera'), '\\Trash'); // ca
    test.equal(byName('Rämps'), '\\Junk'); // et
    test.equal(byName('Skräp'), '\\Junk'); // sv
    test.equal(byName('Ongewenst'), '\\Junk'); // nl
    test.equal(byName('Basura'), '\\Junk'); // es
    test.equal(byName('Arkisto'), '\\Archive'); // fi
    test.done();
};

// ============================================
// Relaxed matching (decorated names and morphological variants)
// ============================================

const sourceOf = name => specialUse.specialUse(false, { flags: new Set(), name }).source;

// Approximate matching is deliberately NOT done. A shared prefix is not enough
// evidence: at five characters English "conceal" reaches Dutch "concepten" and
// "article" reaches Romanian "articole", and a wrongly claimed Trash or Junk folder
// makes a client delete into, or permanently expunge from, an ordinary folder.
// Morphological variants belong in the tables as real entries instead.
module.exports['Special Use: morphological variants are not guessed'] = test => {
    test.equal(byName('Prügikast'), '\\Trash'); // exact table entry
    test.equal(byName('Prügi'), null); // truncation, not matched
    test.equal(byName('Prügikorv'), null); // different ending, not matched
    test.equal(byName('Conceal'), null);
    test.equal(byName('Article'), null);
    test.equal(byName('Postal'), null);
    test.equal(byName('Element'), null);
    test.done();
};

// Known name decorated with a generic mail noun that carries no meaning of its own.
module.exports['Special Use: names decorated with generic mail nouns'] = test => {
    test.equal(byName('Sent Mail'), '\\Sent');
    test.equal(byName('Отправленные письма'), '\\Sent');
    test.equal(byName('Удаленные элементы'), '\\Trash');
    test.equal(byName('Deleted Mail'), '\\Trash');
    test.equal(byName('Spam Messages'), '\\Junk');
    test.equal(byName('Черновики письма'), '\\Drafts');
    test.equal(byName('My Drafts'), '\\Drafts');
    test.equal(byName('Saadetud e-kirjad'), '\\Sent'); // hyphenated "e-" family
    test.done();
};

// Relaxed hits are a guess and must be reported as a distinct, lower priority source
// so that an exactly named folder wins the slot when both exist in one mailbox.
module.exports['Special Use: relaxed matches report a distinct source'] = test => {
    test.equal(sourceOf('Prügikast'), 'name');
    test.equal(sourceOf('Sent'), 'name');
    test.equal(sourceOf('Отправленные письма'), 'name-guess');
    test.equal(sourceOf('Sent Mail'), 'name-guess');
    test.done();
};

// The precision guards. A wrongly flagged Trash or Junk folder is destructive, so
// anything that leaves more than one meaningful word behind must be refused.
module.exports['Special Use: user folders that merely contain a known word are refused'] = test => {
    test.equal(byName('Sent to clients'), null);
    test.equal(byName('Archive 2023'), null);
    test.equal(byName('Junk food recipes'), null);
    test.equal(byName('Drafts of my novel'), null);
    test.equal(byName('Trash talk'), null);
    test.equal(byName('Spam reports'), null);
    test.equal(byName('Deleted scenes'), null);
    test.equal(byName('Corbeilles de fruits'), null);
    test.done();
};

// Ordinary words that share a prefix with an entry must never be classified.
module.exports['Special Use: words sharing only a prefix do not match'] = test => {
    test.equal(byName('Draftsman'), null);
    test.equal(byName('Sentinel'), null);
    test.equal(byName('Sentiments'), null);
    test.equal(byName('Junkyard'), null);
    test.equal(byName('Spammers'), null);
    test.equal(byName('Binder'), null);
    test.equal(byName('Postbox'), null);
    test.equal(byName('Papers'), null);
    test.done();
};

// Every source specialUse() can return has to be ranked by the conflict resolution in
// lib/commands/list.js. A new tier added here without being added there would silently
// sort ahead of an explicit user hint, so pin the vocabulary from this side.
module.exports['Special Use: reports only sources that list.js ranks'] = test => {
    const RANKED = ['user', 'extension', 'name', 'name-guess'];
    const listSource = fs.readFileSync(`${__dirname}/../lib/commands/list.js`, 'utf8');
    const declared = listSource.match(/const SOURCE_SORT_ORDER = \[([^\]]*)\]/);

    test.ok(declared, 'SOURCE_SORT_ORDER not found in lib/commands/list.js');
    test.deepEqual(
        declared[1]
            .split(',')
            .map(part => part.trim().replace(/^'|'$/g, ''))
            .filter(Boolean),
        RANKED
    );

    // and every source this module actually emits is one of them
    const emitted = new Set();
    emitted.add(specialUse.specialUse(true, { flags: new Set(['\\Sent']), name: 'x' }).source);
    emitted.add(specialUse.specialUse(false, { flags: new Set(), name: 'Sent' }).source);
    emitted.add(specialUse.specialUse(false, { flags: new Set(), name: 'Sent Mail' }).source);
    for (let source of emitted) {
        test.ok(RANKED.includes(source), `unranked source: ${source}`);
    }
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

// Lookups normalize the incoming name to NFKC, so an entry stored in any other
// normalization form can never match, however the server spells the folder.
module.exports['Special Use: every name entry is stored in NFKC form'] = test => {
    let problems = [];
    for (let flag of Object.keys(specialUse.names)) {
        for (let name of specialUse.names[flag]) {
            if (name !== name.normalize('NFKC')) {
                problems.push(`${flag}: not NFKC: ${name}`);
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
            for (let form of ['NFC', 'NFD', 'NFKC', 'NFKD']) {
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

// Compatibility folding is the reason lookups normalize with NFKC rather than NFC.
// The Japanese Sent entry was stored with halfwidth katakana, which NFC does not
// fold, so it never matched the fullwidth spelling that servers actually send.
module.exports['Special Use: halfwidth and fullwidth forms fold onto the same entry'] = test => {
    // U+FF92 U+FF70 U+FF99 halfwidth vs U+30E1 U+30FC U+30EB fullwidth katakana
    const halfwidth = '送信済み' + String.fromCodePoint(0xff92, 0xff70, 0xff99);
    const fullwidth = '送信済み' + String.fromCodePoint(0x30e1, 0x30fc, 0x30eb);

    test.equal(byName(halfwidth), '\\Sent');
    test.equal(byName(fullwidth), '\\Sent');
    // Fullwidth Latin, which some CJK clients use for ASCII folder names
    test.equal(byName('Ｓｅｎｔ'), '\\Sent');
    test.equal(byName('Ｔｒａｓｈ'), '\\Trash');
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
