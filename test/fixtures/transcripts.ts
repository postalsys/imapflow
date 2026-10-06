// Server sessions that pin how ImapFlow copes with the quirks of specific servers. Each one is
// written in the transcript format of transcript-server.ts, reconstructed from the server
// behavior the linked code comments and issues describe, and replayed against a real client
// through the public API. The C: lines pin the commands the client sends, so a change that
// makes the client send something these servers reject shows up here.
//
// A new quirk gets a transcript here, with the server it was seen on and where the handling
// lives.

import assert from 'node:assert/strict';
import type { ImapFlow } from '../../src/imap-flow.js';

export interface QuirkTranscript {
    name: string;
    /** Where the quirk was reported or where the client handles it */
    origin: string;
    /** ImapFlow options on top of the defaults the replay test uses */
    options?: Record<string, unknown> | undefined;
    transcript: string;
    /** Drives the client after connect() and checks what it returned */
    run(client: ImapFlow): Promise<void>;
}

export const transcripts: QuirkTranscript[] = [
    {
        name: 'Microsoft 365 advertises LOGINDISABLED before authentication and takes XOAUTH2',
        origin: 'issue #392, imapflow 1.0.184',
        options: { auth: { user: 'user@example.com', accessToken: 'token' } },
        transcript: `
            S: * OK The Microsoft Exchange IMAP4 service is ready. [TQBOADIAUABSADAAMQBDAEEAMAAwADAANwA=]
            C: CAPABILITY
            S: * CAPABILITY IMAP4 IMAP4rev1 AUTH=XOAUTH2 LOGINDISABLED SASL-IR UIDPLUS ID UNSELECT CHILDREN IDLE NAMESPACE LITERAL+
            S: TAG OK CAPABILITY completed.
            C: ID (
            S: * ID ("name" "Microsoft.Exchange.Imap4.Imap4Server" "version" "15.20")
            S: TAG OK ID completed.
            C: AUTHENTICATE XOAUTH2 dXNlcj11c2VyQGV4YW1wbGUuY29tAWF1dGg9QmVhcmVyIHRva2VuAQE=
            S: TAG OK AUTHENTICATE completed.
            C: CAPABILITY
            S: * CAPABILITY IMAP4 IMAP4rev1 AUTH=XOAUTH2 SASL-IR UIDPLUS MOVE ID UNSELECT CLIENTACCESSRULES CLIENTNETWORKPRESENCELOCATION BACKENDAUTHENTICATE CHILDREN IDLE NAMESPACE LITERAL+
            S: TAG OK CAPABILITY completed.
            C: NAMESPACE
            S: * NAMESPACE (("" "/")) NIL NIL
            S: TAG OK NAMESPACE completed.
        `,
        async run(client) {
            assert.ok(client.authenticated);
            assert.equal(client.capabilities.has('LOGINDISABLED'), false, 'the post-auth capability list replaced the pre-auth one');
        }
    },
    {
        name: 'home.pl writes two LIST flags without the space between them',
        origin: 'src/handler/token-parser.ts, flag split in STATE_ATOM',
        transcript: `
            S: * OK [CAPABILITY IMAP4rev1 LITERAL+ SASL-IR LOGIN-REFERRALS ID ENABLE IDLE AUTH=PLAIN] home.pl IMAP ready
            C: ID (
            S: * ID ("name" "home.pl" "vendor" "home.pl S.A.")
            S: TAG OK ID completed
            C: AUTHENTICATE PLAIN
            S: TAG OK [CAPABILITY IMAP4rev1 LITERAL+ SASL-IR LOGIN-REFERRALS ID ENABLE IDLE SORT THREAD=REFERENCES MULTIAPPEND UNSELECT CHILDREN NAMESPACE UIDPLUS LIST-EXTENDED SPECIAL-USE MOVE] Logged in
            C: NAMESPACE
            S: * NAMESPACE (("" "/")) NIL NIL
            S: TAG OK Namespace completed
            C: LIST "" "*"
            S: * LIST (\\HasNoChildren) "/" INBOX
            S: * LIST (\\Sent\\HasNoChildren) "/" Sent
            S: * LIST (\\HasNoChildren\\Trash) "/" Trash
            S: TAG OK List completed
            C: LSUB "" "*"
            S: * LSUB () "/" INBOX
            S: * LSUB () "/" Sent
            S: TAG OK Lsub completed
        `,
        async run(client) {
            const listing = await client.list();
            const byPath = new Map(listing.map(entry => [entry.path, entry]));
            assert.equal(byPath.get('Sent')?.specialUse, '\\Sent');
            assert.equal(byPath.get('Trash')?.specialUse, '\\Trash');
            assert.ok(byPath.get('Sent')?.flags.has('\\HasNoChildren'));
            assert.equal(listing.length, 3);
        }
    },
    {
        name: 'Yahoo answers a small body section with a quoted string instead of a literal',
        origin: 'src/tools.ts, getBuffer() in parseFetchResponse()',
        transcript: `
            S: * OK [CAPABILITY IMAP4rev1 ID MOVE NAMESPACE XYMHIGHESTMODSEQ UIDPLUS LITERAL+ CHILDREN X-MSG-EXT UNSELECT OBJECTID] IMAP4rev1 Hello
            # an ID answer with fewer than two fields before login is asked again after it
            C: ID (
            S: * ID NIL
            S: TAG OK ID completed
            C: LOGIN
            S: TAG OK LOGIN completed
            C: CAPABILITY
            S: * CAPABILITY IMAP4rev1 ID MOVE NAMESPACE XYMHIGHESTMODSEQ UIDPLUS LITERAL+ CHILDREN X-MSG-EXT UNSELECT OBJECTID
            S: TAG OK CAPABILITY completed
            C: ID (
            S: * ID ("name" "Yahoo" "vendor" "Yahoo Inc")
            S: TAG OK ID completed
            C: NAMESPACE
            S: * NAMESPACE (("" "/")) NIL NIL
            S: TAG OK NAMESPACE completed
            C: LIST "" "INBOX"
            S: * LIST (\\HasNoChildren) "/" INBOX
            S: TAG OK LIST completed
            C: LSUB "" "INBOX"
            S: * LSUB () "/" INBOX
            S: TAG OK LSUB completed
            C: SELECT INBOX
            S: * 1 EXISTS
            S: * 0 RECENT
            S: * OK [UIDVALIDITY 1600000000] UIDs valid
            S: * OK [UIDNEXT 8] Predicted next UID
            S: * FLAGS (\\Answered \\Deleted \\Draft \\Flagged \\Seen $Forwarded $Junk $NotJunk)
            S: * OK [PERMANENTFLAGS (\\Answered \\Deleted \\Draft \\Flagged \\Seen $Forwarded $Junk $NotJunk)] Permanent flags
            S: TAG OK [READ-WRITE] SELECT completed; now in selected state
            C: UID FETCH 7 (EMAILID UID BODY.PEEK[1] BODY.PEEK[2])
            S: * 1 FETCH (EMAILID (M6d99ac3275bb4e) UID 7 BODY[1] "Hello \\"world\\" \\\\o/" BODY[2] {8}
            S: <b>x</b>)
            S: TAG OK UID FETCH completed
        `,
        async run(client) {
            await client.mailboxOpen('INBOX');
            const message = await client.fetchOne('7', { bodyParts: ['1', '2'] }, { uid: true });
            assert.ok(message);
            assert.equal(message.bodyParts?.get('1')?.toString(), 'Hello "world" \\o/');
            assert.equal(message.bodyParts?.get('2')?.toString(), '<b>x</b>');
            assert.equal(message.emailId, 'M6d99ac3275bb4e');
        }
    },
    {
        name: 'COPYUID arrives in an untagged OK before the tagged MOVE completion',
        origin: 'src/commands/move.ts',
        transcript: `
            S: * OK [CAPABILITY IMAP4rev1 UIDPLUS MOVE NAMESPACE] ready
            C: LOGIN
            S: TAG OK LOGIN completed
            C: CAPABILITY
            S: * CAPABILITY IMAP4rev1 UIDPLUS MOVE NAMESPACE
            S: TAG OK CAPABILITY completed
            C: NAMESPACE
            S: * NAMESPACE (("" "/")) NIL NIL
            S: TAG OK NAMESPACE completed
            C: LIST "" "INBOX"
            S: * LIST (\\HasNoChildren) "/" INBOX
            S: TAG OK LIST completed
            C: LSUB "" "INBOX"
            S: * LSUB () "/" INBOX
            S: TAG OK LSUB completed
            C: SELECT INBOX
            S: * 3 EXISTS
            S: * OK [UIDVALIDITY 5] UIDs valid
            S: * OK [UIDNEXT 40] Predicted next UID
            S: TAG OK [READ-WRITE] SELECT completed
            C: UID MOVE 31:32 Archive
            S: * OK [COPYUID 77 31:32 900:901] Moved
            S: * 2 EXPUNGE
            S: * 2 EXPUNGE
            S: TAG OK MOVE completed
        `,
        async run(client) {
            await client.mailboxOpen('INBOX');
            const result = await client.messageMove('31:32', 'Archive', { uid: true });
            assert.ok(result);
            assert.equal(result.destination, 'Archive');
            assert.equal(result.uidValidity, 77n);
            assert.deepEqual(
                [...result.uidMap!],
                [
                    [31, 900],
                    [32, 901]
                ]
            );
            assert.equal(client.mailbox && client.mailbox.exists, 1);
        }
    },
    {
        name: 'mailbox paths prefixed with the hierarchy delimiter',
        origin: 'src/commands/list.ts, leading delimiter strip',
        transcript: `
            S: * OK [CAPABILITY IMAP4rev1 NAMESPACE] ready
            C: LOGIN
            S: TAG OK LOGIN completed
            C: CAPABILITY
            S: * CAPABILITY IMAP4rev1 NAMESPACE
            S: TAG OK CAPABILITY completed
            C: NAMESPACE
            S: * NAMESPACE (("" "/")) NIL NIL
            S: TAG OK NAMESPACE completed
            C: LIST "" "*"
            S: * LIST (\\HasChildren) "/" "/Projects"
            S: * LIST (\\HasNoChildren) "/" "/Projects/2026"
            S: * LIST (\\HasNoChildren) "/" INBOX
            S: TAG OK LIST completed
            C: LSUB "" "*"
            S: * LSUB () "/" "/Projects/2026"
            S: TAG OK LSUB completed
        `,
        async run(client) {
            const listing = await client.list();
            const paths = listing.map(entry => entry.path).sort();
            assert.deepEqual(paths, ['INBOX', 'Projects', 'Projects/2026']);
            const child = listing.find(entry => entry.path === 'Projects/2026');
            assert.equal(child?.parentPath, 'Projects');
            assert.equal(child?.subscribed, true);
        }
    },
    {
        name: 'responses padded with leading NUL bytes',
        origin: 'src/handler/imap-parser.ts, NUL padding workaround',
        transcript: `
            S: * OK [CAPABILITY IMAP4rev1 NAMESPACE] ready
            C: LOGIN
            S: \0\0TAG OK LOGIN completed
            C: CAPABILITY
            S: \0* CAPABILITY IMAP4rev1 NAMESPACE
            S: TAG OK CAPABILITY completed
            C: NAMESPACE
            S: * NAMESPACE (("" "/")) NIL NIL
            S: \0\0\0TAG OK NAMESPACE completed
            C: STATUS INBOX (MESSAGES UIDNEXT)
            S: \0* STATUS INBOX (MESSAGES 12 UIDNEXT 99)
            S: TAG OK STATUS completed
        `,
        async run(client) {
            const status = await client.status('INBOX', { messages: true, uidNext: true });
            assert.ok(status);
            assert.equal(status.messages, 12);
            assert.equal(status.uidNext, 99);
        }
    },
    {
        name: 'Dovecot sends digit-led mailbox names and keywords unquoted',
        origin: 'Dovecot 2.4.4, src/handler/token-parser.ts digit-led atom fallback',
        transcript: `
            S: * OK [CAPABILITY IMAP4rev1 LITERAL+ SASL-IR LOGIN-REFERRALS ID ENABLE IDLE AUTH=PLAIN] Dovecot ready.
            C: ID (
            S: * ID ("name" "Dovecot" "version" "2.4.4")
            S: TAG OK ID completed.
            C: AUTHENTICATE PLAIN
            S: TAG OK [CAPABILITY IMAP4rev1 SASL-IR LOGIN-REFERRALS ID ENABLE IDLE NAMESPACE UIDPLUS CHILDREN UNSELECT MOVE] Logged in
            C: NAMESPACE
            S: * NAMESPACE (("" "/")) NIL NIL
            S: TAG OK Namespace completed.
            C: LIST "" "*"
            S: * LIST (\\HasNoChildren) "/" 1,a
            S: * LIST (\\HasNoChildren) "/" 2024:Q1
            S: * LIST (\\HasNoChildren) "/" 10:
            S: * LIST (\\HasNoChildren) "/" 12:30:00
            S: * LIST (\\HasNoChildren) "/" INBOX
            S: TAG OK List completed.
            C: LSUB "" "*"
            S: * LSUB () "/" 2024:Q1
            S: * LSUB () "/" INBOX
            S: TAG OK Lsub completed.
            C: STATUS 2024:Q1 (MESSAGES UNSEEN)
            S: * STATUS 2024:Q1 (MESSAGES 4 UNSEEN 1)
            S: TAG OK Status completed.
            C: SELECT INBOX
            S: * FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft 1:x 2024:taxes)
            S: * OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft 1:x 2024:taxes \\*)] Flags permitted.
            S: * 2 EXISTS
            S: * OK [UIDVALIDITY 1791276000] UIDs valid
            S: * OK [UIDNEXT 3] Predicted next UID
            S: TAG OK [READ-WRITE] Select completed.
            C: FETCH 1:* (FLAGS UID)
            S: * 1 FETCH (UID 1 FLAGS (\\Seen 1:x))
            S: * 2 FETCH (UID 2 FLAGS (2024:taxes))
            S: TAG OK Fetch completed.
        `,
        async run(client) {
            const paths = (await client.list()).map(entry => entry.path).sort();
            assert.deepEqual(paths, ['1,a', '10:', '12:30:00', '2024:Q1', 'INBOX']);

            const status = await client.status('2024:Q1', { messages: true, unseen: true });
            assert.ok(status);
            assert.equal(status.messages, 4);
            assert.equal(status.unseen, 1);

            await client.mailboxOpen('INBOX');
            assert.ok(client.mailbox && client.mailbox.flags.has('2024:taxes'));
            assert.ok(client.mailbox && client.mailbox.permanentFlags?.has('1:x'));

            const messages = await client.fetchAll('1:*', { flags: true });
            assert.deepEqual(
                messages.map(message => [message.uid, [...(message.flags || [])]]),
                [
                    [1, ['\\Seen', '1:x']],
                    [2, ['2024:taxes']]
                ]
            );
        }
    }
];
