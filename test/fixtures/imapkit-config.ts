// The ImapKit setup the in-process tests use, without importing ImapKit or ImapFlow, so the
// browser page (test/browser/page.ts) can bundle it too

// Every plugin that can be loaded together with the others. Left out: ACL (non-owner users lose
// their rights), LITERALMINUS and SAVELIMIT (conflict with LITERALPLUS and MESSAGELIMIT),
// LOGINDISABLED and UIDONLY (change how a session works, tested on their own), METADATA-SERVER (a
// subset of METADATA) and XTOYBIRD (test control commands).
export const ALL_PLUGINS = [
    'APPENDLIMIT',
    'AUTH-PLAIN',
    'BINARY',
    'CATENATE',
    'COMPRESS',
    'CONDSTORE',
    'CONTEXT=SEARCH',
    'CONTEXT=SORT',
    'CREATE-SPECIAL-USE',
    'ENABLE',
    'ESEARCH',
    'ESORT',
    'ID',
    'IDLE',
    'IMAP4rev2',
    'LIST-EXTENDED',
    'LIST-STATUS',
    'LITERALPLUS',
    'MESSAGELIMIT',
    'METADATA',
    'MOVE',
    'MULTIAPPEND',
    'MULTISEARCH',
    'NAMESPACE',
    'NOTIFY',
    'OAUTHBEARER',
    'OBJECTID',
    'PARTIAL',
    'PREVIEW',
    'QRESYNC',
    'QUOTA',
    'REPLACE',
    'SASL-IR',
    'SAVEDATE',
    'SEARCHRES',
    'SORT',
    'SORT=DISPLAY',
    'SPECIAL-USE',
    'STARTTLS',
    'STATUS=SIZE',
    'THREAD=ORDEREDSUBJECT',
    'THREAD=REFERENCES',
    'UIDPLUS',
    'UNAUTHENTICATE',
    'UNSELECT',
    'UTF8=ACCEPT',
    'X-GM-EXT-1',
    'XOAUTH2'
];

// A mailbox tree with the usual special-use folders
export const DEFAULT_STORAGE = {
    INBOX: {},
    '': {
        separator: '/',
        folders: {
            Archive: { 'special-use': '\\Archive' },
            Drafts: { 'special-use': '\\Drafts' },
            Junk: { 'special-use': '\\Junk' },
            Sent: { 'special-use': '\\Sent' },
            Trash: { 'special-use': '\\Trash' }
        }
    }
};
