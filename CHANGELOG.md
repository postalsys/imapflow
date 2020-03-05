# CHANGELOG

-   1.0.29 - 2020-03-05

    -   Updated JSDoc for some optional params
    -   Better PREAUTH support

-   1.0.28 - 2020-03-04

    -   Changed license of the project from UNLICENSED to AGPL-3.0-or-later

-   1.0.27 - 2020-03-02

    -   Added support for XOAUTH2 and OAUTHBEARERTOKEN authentication mechanisms

-   1.0.16 - 2020-02-15

    -   Logging level changes (FETCH responses downgraded from DEBUG to TRACE)

-   1.0.14 - 2020-02-13

    -   Added new property `idling`

-   v1.0.13 - 2020-02-12

    -   Do not filter out changes with same MODSEQ value

-   v1.0.12 - 2020-02-12

    -   Logging level changes

-   v1.0.11 - 2020-02-06

    -   Bump current uidNext if message UID seems to be higher

-   v1.0.10 - 2020-02-02

    -   Use debug logging level for IMAP traffic

-   v1.0.9 - 2020-02-02

    -   Yet another documentation change to get TypeScript typings more correct

-   v1.0.8 - 2020-02-02

    -   Documented missing option changedSince for fetch
    -   Emit changes also on STATUS

-   v1.0.7 - 2020-01-31

    -   Added new method `getMailboxLock()` to lock a mailbox for usage
    -   Added new connection events "mailboxOpen" and "mailboxClose"

-   v1.0.6 - 2020-01-30

    -   Updated TypeScript typings
    -   Updated ID request formatting

-   v1.0.5 - 2020-01-29

    -   Updated TypeScript typings

-   v1.0.3 - 2020-01-28

    -   Fixed eternal loop when breaking IDLE after connection is closed

-   v1.0.2 - 2020-01-24

    -   Allow using emailId and threadId as search parameters

-   v1.0.1 - 2020-01-14

    -   Initial version. Had to use v1.0.1 as v1.0.0 was already taken by template repository.
