# CHANGELOG

-   1.0.75 - 2021-10-15

    -   Fixed an exception with failing IDLE (ramiroaisen #60)
    -   Do not use 1 and 1.MIME for single node messages, fallback to TEXT and HEADERS

-   1.0.71 - 2021-09-28

    -   IDLE precheck changes

-   1.0.70 - 2021-09-27

    -   IDLE logging changes

-   1.0.69 - 2021-09-27

    -   Added option `logRaw` to log data read from and written to the socket

-   1.0.68 - 2021-09-16

    -   Decrease message count on untagged EXPUNGE even if EXISTS does not follow

-   1.0.67 - 2021-08-02

    -   Added new option `chunkSize` for `download()` options

-   1.0.66 - 2021-07-30

    -   Meta update to change README
    -   Replaced andris9/imapflow with postalsys/imapflow

-   1.0.65 - 2021-07-25

    -   Changed project license from AGPL to MIT

-   1.0.59 - 2021-06-16

    -   Fixed issue with complex OR search

-   1.0.57 - 2021-04-30

    -   Do not wait indefinitely after logout if connection was not established

-   1.0.56 - 2021-03-18

    -   Fixed issue with exploding LOGOUT

-   1.0.55 - 2021-03-17

    -   Fixed raw source downloads

-   1.0.53 - 2021-02-17
-   1.0.52 - 2021-02-17

    -   Fixed HTML content loading for some messages from Outlook/Hotmail

-   1.0.51 - 2020-09-24

    -   Close connection after LOGOUT even if command fails

-   1.0.49 - 2020-09-02

    -   When connection is closed mid-command then reject the promise instead of going blank
    -   Fix issue with search({uid:'1:\*'})

-   1.0.47 - 2020-05-29

    -   Fix search query with `{header:{key: true}}`

-   1.0.46 - 2020-05-15

    -   Do not use IP address as SNI servername

-   1.0.45 - 2020-05-02

    -   Better support for XOAUTH2

-   1.0.44 - 2020-04-20

    -   Better detcting of special use mailboxes

-   1.0.43 - 2020-04-20

    -   Better handling of NIL as delimiter

-   1.0.42 - 2020-04-13

    -   Try to hande edge case when authenticating against Exchange IMAP

-   1.0.41 - 2020-04-12

    -   Bumped deps
    -   Log 'close' event

-   1.0.40 - 2020-04-06

    -   Added option `useLabels` for message flag update methods to modify Gmail labels instead of message flags

-   1.0.36 - 2020-03-26

    -   Do not try to write to socket if connection already closed

-   1.0.35 - 2020-03-25

    -   Set time argument for setKeepAlive

-   1.0.34 - 2020-03-25

    -   Replaced nodemailer/imapflow with andris9/imapflow
    -   Removed TS typings

-   1.0.33 - 2020-03-20

    -   Fixed issue with using date queries in search [a0000778](1e6ce952)

-   1.0.30 - 2020-03-06

    -   Added new option and property `emitLogs` and `'log'` event to fire on every log entry

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
