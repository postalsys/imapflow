import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as specialUse from '../src/special-use.js';
import fs from 'node:fs';

// ============================================
// Localized folder name detection
// ============================================

// Helper: resolve a folder name the way a server without SPECIAL-USE would be handled.
const byName = (name: any) => specialUse.specialUse(false, { flags: new Set(), name }).flag;

// ============================================
// Relaxed matching (decorated names and morphological variants)
// ============================================

const sourceOf = (name: any) => specialUse.specialUse(false, { flags: new Set(), name }).source;

describe('special-use', () => {
    it('Special Use: flags array', () => {
        assert.ok(Array.isArray(specialUse.flags));
        assert.ok(specialUse.flags.includes('\\Sent'));
        assert.ok(specialUse.flags.includes('\\Drafts'));
        assert.ok(specialUse.flags.includes('\\Trash'));
        assert.ok(specialUse.flags.includes('\\Archive'));
    });
    it('Special Use: names object', () => {
        assert.ok(typeof specialUse.names === 'object');
        assert.ok(specialUse.names['\\Sent']);
        assert.ok(Array.isArray(specialUse.names['\\Sent']));
        assert.ok(specialUse.names['\\Sent'].includes('sent'));
    });
    it('Special Use: Sent folder names', () => {
        let sentNames = specialUse.names['\\Sent'];
        assert.ok(sentNames.includes('sent'));
        assert.ok(sentNames.includes('sent items'));
        assert.ok(sentNames.includes('sent messages'));
    });
    it('Special Use: Drafts folder names', () => {
        let draftsNames = specialUse.names['\\Drafts'];
        assert.ok(draftsNames.includes('drafts'));
    });
    it('Special Use: Trash folder names', () => {
        let trashNames = specialUse.names['\\Trash'];
        assert.ok(trashNames.includes('trash'));
        assert.ok(trashNames.includes('deleted items'));
        assert.ok(trashNames.includes('deleted messages'));
    });
    it('Special Use: Junk folder names', () => {
        let junkNames = specialUse.names['\\Junk'];
        assert.ok(junkNames.includes('spam'));
        assert.ok(junkNames.includes('junk'));
    });

    // ============================================
    // specialUse() function branch tests
    // ============================================
    it('Special Use: specialUse returns extension flag when extension enabled and flag found', () => {
        const result = specialUse.specialUse(true, { flags: new Set(['\\Sent']), name: 'Foo' });
        assert.equal(result.flag, '\\Sent');
        assert.equal(result.source, 'extension');
    });
    it('Special Use: specialUse falls back to name when extension enabled but no flag', () => {
        const result = specialUse.specialUse(true, { flags: new Set(), name: 'Sent' });
        assert.equal(result.flag, '\\Sent');
        assert.equal(result.source, 'name');
    });
    it('Special Use: specialUse matches by name when extension disabled', () => {
        const result = specialUse.specialUse(false, { flags: new Set(), name: 'Drafts' });
        assert.equal(result.flag, '\\Drafts');
        assert.equal(result.source, 'name');
    });
    it('Special Use: specialUse returns null flag when no match', () => {
        const result = specialUse.specialUse(false, { flags: new Set(), name: 'CustomFolder' });
        assert.equal(result.flag, null);
        assert.equal(result.source, undefined);
    });

    // Regression: Exchange/Outlook does not advertise SPECIAL-USE, so a Russian-locale
    // mailbox has to resolve purely by folder name. Junk and Archive used to fall through.
    it('Special Use: Russian Outlook mailbox resolves every special-use folder', () => {
        assert.equal(byName('Отправленные'), '\\Sent');
        assert.equal(byName('Черновики'), '\\Drafts');
        assert.equal(byName('Удаленные'), '\\Trash');
        assert.equal(byName('Нежелательная почта'), '\\Junk');
        assert.equal(byName('Архив'), '\\Archive');
    });

    // Non-mail folders exposed over IMAP by Exchange must stay unclassified.
    it('Special Use: Russian calendar and contacts folders stay unmatched', () => {
        assert.equal(byName('Календарь'), null);
        assert.equal(byName('Контакты'), null);
    });

    // Russian webmail (Yandex, Mail.ru, Rambler) uses different words than Outlook.
    it('Special Use: Russian webmail folder names', () => {
        assert.equal(byName('Корзина'), '\\Trash');
        assert.equal(byName('Удалённые'), '\\Trash'); // spelled with a real "ё"
        assert.equal(byName('Спам'), '\\Junk');
    });
    it('Special Use: Archive folder names across locales', () => {
        assert.equal(byName('Archive'), '\\Archive');
        assert.equal(byName('Архив'), '\\Archive');
        assert.equal(byName('Архів'), '\\Archive');
        assert.equal(byName('Archiv'), '\\Archive');
        assert.equal(byName('Archivo'), '\\Archive');
        assert.equal(byName('Arquivo'), '\\Archive');
        assert.equal(byName('Archivio'), '\\Archive');
        assert.equal(byName('Archief'), '\\Archive');
        assert.equal(byName('Arkiv'), '\\Archive');
        assert.equal(byName('Arşiv'), '\\Archive');
        assert.equal(byName('アーカイブ'), '\\Archive');
        assert.equal(byName('보관함'), '\\Archive');
    });
    it('Special Use: Junk folder names across locales', () => {
        assert.equal(byName('Junk Email'), '\\Junk');
        assert.equal(byName('Нежелательная почта'), '\\Junk');
        assert.equal(byName('Небажана пошта'), '\\Junk');
        assert.equal(byName('Ongewenste e-mail'), '\\Junk');
        assert.equal(byName('Lixo Eletrônico'), '\\Junk');
        assert.equal(byName('Neželjena pošta'), '\\Junk');
        assert.equal(byName('迷惑メール'), '\\Junk');
        assert.equal(byName('정크 메일'), '\\Junk');
    });
    it('Special Use: Trash folder names across locales', () => {
        assert.equal(byName('Deleted Items'), '\\Trash');
        assert.equal(byName('Corbeille'), '\\Trash');
        assert.equal(byName('Papierkorb'), '\\Trash');
        assert.equal(byName('Papelera'), '\\Trash');
        assert.equal(byName('Cestino'), '\\Trash');
        assert.equal(byName('Kosz'), '\\Trash');
        assert.equal(byName('ゴミ箱'), '\\Trash');
        assert.equal(byName('휴지통'), '\\Trash');
    });

    // Matching lowercases the folder name, so non-ASCII scripts must fold too.
    it('Special Use: name matching is case insensitive for non-ASCII names', () => {
        assert.equal(byName('НЕЖЕЛАТЕЛЬНАЯ ПОЧТА'), '\\Junk');
        assert.equal(byName('АРХИВ'), '\\Archive');
        assert.equal(byName('Корзина'), '\\Trash');
    });

    // Surrounding whitespace and the LTR mark injected by some clients are stripped.
    it('Special Use: strips whitespace and LTR marks before matching', () => {
        assert.equal(byName('  Архив  '), '\\Archive');
        assert.equal(byName('\u200eНежелательная почта'), '\\Junk');
    });

    // Exchange and Outlook use a two word naming style ("Sent Items") that differs from
    // the one word style most webmail uses ("Sent"), and they never advertise SPECIAL-USE,
    // so these names have to resolve by name alone.
    it('Special Use: Exchange and Outlook localized folder names', () => {
        assert.equal(byName('Sent Items'), '\\Sent');
        assert.equal(byName('Deleted Items'), '\\Trash');
        assert.equal(byName('Junk Email'), '\\Junk');
        assert.equal(byName('Gesendete Elemente'), '\\Sent');
        assert.equal(byName('Gelöschte Elemente'), '\\Trash');
        assert.equal(byName('Éléments envoyés'), '\\Sent');
        assert.equal(byName('Elementos eliminados'), '\\Trash');
        assert.equal(byName('Posta eliminata'), '\\Trash');
        assert.equal(byName('Verzonden items'), '\\Sent');
        assert.equal(byName('Elementy usunięte'), '\\Trash');
        assert.equal(byName('Elemente șterse'), '\\Trash');
        assert.equal(byName('Sendte elementer'), '\\Sent');
        assert.equal(byName('Gönderilmiş Öğeler'), '\\Sent');
        assert.equal(byName('Önemsiz E-posta'), '\\Junk');
        assert.equal(byName('送信済みアイテム'), '\\Sent');
        assert.equal(byName('削除済みアイテム'), '\\Trash');
        assert.equal(byName('보낸 편지함'), '\\Sent');
    });

    // Names harvested from the localization catalogs of Roundcube, SOGo and Thunderbird.
    // These are the cases that motivated, and are now covered without, approximate matching.
    it('Special Use: names taken from mail client localization catalogs', () => {
        assert.equal(byName('Gesendet'), '\\Sent'); // de, Thunderbird
        assert.equal(byName('Skickat'), '\\Sent'); // sv
        assert.equal(byName('Gelöscht'), '\\Trash'); // de, Roundcube
        assert.equal(byName('Poubelle'), '\\Trash'); // fr
        assert.equal(byName('Paperera'), '\\Trash'); // ca
        assert.equal(byName('Rämps'), '\\Junk'); // et
        assert.equal(byName('Skräp'), '\\Junk'); // sv
        assert.equal(byName('Ongewenst'), '\\Junk'); // nl
        assert.equal(byName('Basura'), '\\Junk'); // es
        assert.equal(byName('Arkisto'), '\\Archive');
    });

    // Approximate matching is deliberately NOT done. A shared prefix is not enough
    // evidence: at five characters English "conceal" reaches Dutch "concepten" and
    // "article" reaches Romanian "articole", and a wrongly claimed Trash or Junk folder
    // makes a client delete into, or permanently expunge from, an ordinary folder.
    // Morphological variants belong in the tables as real entries instead.
    it('Special Use: morphological variants are not guessed', () => {
        assert.equal(byName('Prügikast'), '\\Trash'); // exact table entry
        assert.equal(byName('Prügi'), null); // truncation, not matched
        assert.equal(byName('Prügikorv'), null); // different ending, not matched
        assert.equal(byName('Conceal'), null);
        assert.equal(byName('Article'), null);
        assert.equal(byName('Postal'), null);
        assert.equal(byName('Element'), null);
    });

    // Known name decorated with a generic mail noun that carries no meaning of its own.
    it('Special Use: names decorated with generic mail nouns', () => {
        assert.equal(byName('Sent Mail'), '\\Sent');
        assert.equal(byName('Отправленные письма'), '\\Sent');
        assert.equal(byName('Удаленные элементы'), '\\Trash');
        assert.equal(byName('Deleted Mail'), '\\Trash');
        assert.equal(byName('Spam Messages'), '\\Junk');
        assert.equal(byName('Черновики письма'), '\\Drafts');
        assert.equal(byName('My Drafts'), '\\Drafts');
        assert.equal(byName('Saadetud e-kirjad'), '\\Sent');
    });

    // Relaxed hits are a guess and must be reported as a distinct, lower priority source
    // so that an exactly named folder wins the slot when both exist in one mailbox.
    it('Special Use: relaxed matches report a distinct source', () => {
        assert.equal(sourceOf('Prügikast'), 'name');
        assert.equal(sourceOf('Sent'), 'name');
        assert.equal(sourceOf('Отправленные письма'), 'name-guess');
        assert.equal(sourceOf('Sent Mail'), 'name-guess');
    });

    // The precision guards. A wrongly flagged Trash or Junk folder is destructive, so
    // anything that leaves more than one meaningful word behind must be refused.
    it('Special Use: user folders that merely contain a known word are refused', () => {
        assert.equal(byName('Sent to clients'), null);
        assert.equal(byName('Archive 2023'), null);
        assert.equal(byName('Junk food recipes'), null);
        assert.equal(byName('Drafts of my novel'), null);
        assert.equal(byName('Trash talk'), null);
        assert.equal(byName('Spam reports'), null);
        assert.equal(byName('Deleted scenes'), null);
        assert.equal(byName('Corbeilles de fruits'), null);
    });

    // Ordinary words that share a prefix with an entry must never be classified.
    it('Special Use: words sharing only a prefix do not match', () => {
        assert.equal(byName('Draftsman'), null);
        assert.equal(byName('Sentinel'), null);
        assert.equal(byName('Sentiments'), null);
        assert.equal(byName('Junkyard'), null);
        assert.equal(byName('Spammers'), null);
        assert.equal(byName('Binder'), null);
        assert.equal(byName('Postbox'), null);
        assert.equal(byName('Papers'), null);
    });

    // Every source specialUse() can return has to be ranked by the conflict resolution in
    // src/commands/list.ts. A new tier added here without being added there would silently
    // sort ahead of an explicit user hint, so pin the vocabulary from this side.
    it('Special Use: reports only sources that list.ts ranks', () => {
        const RANKED = ['user', 'extension', 'name', 'name-guess'];
        const listSource = fs.readFileSync(new URL('../src/commands/list.ts', import.meta.url), 'utf8');
        const declared = listSource.match(/const SOURCE_SORT_ORDER[^=]*= \[([^\]]*)\]/);

        assert.ok(declared, 'SOURCE_SORT_ORDER not found in src/commands/list.ts');
        assert.deepEqual(
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
        for (let source of emitted as any) {
            assert.ok(RANKED.includes(source), `unranked source: ${source}`);
        }
    });

    // ============================================
    // Structural guards for the name tables
    // ============================================

    // A name listed under two different flags would make detection depend on key order.
    it('Special Use: no folder name is claimed by two flags', () => {
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
        assert.deepEqual(collisions, []);
    });

    // Lookups normalize the incoming name to NFKC, so an entry stored in any other
    // normalization form can never match, however the server spells the folder.
    it('Special Use: every name entry is stored in NFKC form', () => {
        let problems = [];
        for (let flag of Object.keys(specialUse.names)) {
            for (let name of specialUse.names[flag]) {
                if (name !== name.normalize('NFKC')) {
                    problems.push(`${flag}: not NFKC: ${name}`);
                }
            }
        }
        assert.deepEqual(problems, []);
    });

    // Servers echo back whatever normalization form the creating client used, so both
    // canonically equivalent spellings of a name must resolve to the same flag.
    it('Special Use: matching is independent of Unicode normalization form', () => {
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
        assert.deepEqual(mismatches, []);
    });

    // Compatibility folding is the reason lookups normalize with NFKC rather than NFC.
    // The Japanese Sent entry was stored with halfwidth katakana, which NFC does not
    // fold, so it never matched the fullwidth spelling that servers actually send.
    it('Special Use: halfwidth and fullwidth forms fold onto the same entry', () => {
        // U+FF92 U+FF70 U+FF99 halfwidth vs U+30E1 U+30FC U+30EB fullwidth katakana
        const halfwidth = '送信済み' + String.fromCodePoint(0xff92, 0xff70, 0xff99);
        const fullwidth = '送信済み' + String.fromCodePoint(0x30e1, 0x30fc, 0x30eb);

        assert.equal(byName(halfwidth), '\\Sent');
        assert.equal(byName(fullwidth), '\\Sent');
        // Fullwidth Latin, which some CJK clients use for ASCII folder names
        assert.equal(byName('Ｓｅｎｔ'), '\\Sent');
        assert.equal(byName('Ｔｒａｓｈ'), '\\Trash');
    });

    // Devanagari and Bengali nukta letters are Unicode composition exclusions: the
    // precomposed character is NOT the NFC form, so these two entries used to match
    // only if the server happened to send the precomposed spelling.
    it('Special Use: nukta drafts folders match in either spelling', () => {
        // U+095E DEVANAGARI LETTER PHA WITH NUKTA vs U+092B U+093C
        const hindi = String.fromCodePoint(0x0921, 0x094d, 0x0930, 0x093e, 0x095e, 0x094d, 0x091f);
        // U+09DC BENGALI LETTER RRA vs U+09A1 U+09BC
        const bengali = String.fromCodePoint(0x0996, 0x09b8, 0x09dc, 0x09be);

        assert.equal(byName(hindi), '\\Drafts');
        assert.equal(byName(hindi.normalize('NFC')), '\\Drafts');
        assert.equal(byName(bengali), '\\Drafts');
        assert.equal(byName(bengali.normalize('NFC')), '\\Drafts');
    });

    // Lookups compare against a lowercased and trimmed name, so entries stored in any
    // other form are dead weight that can never match.
    it('Special Use: every name entry is lowercase, trimmed and unique', () => {
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
        assert.deepEqual(problems, []);
    });
});
