# CHANGELOG

-   1.0.118 - 2022-12-22

    -   Refactored detecting special use folders

-   1.0.117 - 2022-12-05

    -   Updated command compiling. The command compiler returns a Buffer, not a "binary" string.

-   1.0.116 - 2022-11-30

    -   Added `SPECIAL-USE` flag by default when given parameters to `Imap#list`

-   1.0.113 - 2022-10-21

    -   Added `stats()` method to get the count of bytes sent and received

-   1.0.112 - 2022-10-16

    -   Improved ID compatiblity with servers that allow ID only after login

-   1.0.111 - 2022-10-13

    -   Added new connection options
        -   connectionTimeout=90000: how many milliseconds to wait for the connection to establish (default is 90 seconds)
        -   greetingTimeout=16000: how many milliseconds to wait for the greeting after connection is established (default is 16 seconds)
        -   socketTimeout=300000: how many milliseconds of inactivity to allow (default is 5 minutes)

-   1.0.110 - 2022-10-10

    -   Allow unicode atoms by default

-   1.0.109 - 2022-09-29

    -   New method `downloadMany`

-   1.0.102 - 2022-08-18

    -   Added new option `{statusQuery: {<statusOptions>}` for `list()` method
    -   Added support for LIST-STATUS extension https://datatracker.ietf.org/doc/html/rfc5819

-   1.0.100 - 2022-06-17

    -   Emit new message notification if appending to currently opened folder

-   1.0.99 - 2022-06-05

    -   Check if folder exists on failed status command

-   1.0.98 - 2022-05-30

    -   Fixed an issue with envelope parsing where literal values were returned as Buffers

-   1.0.97 - 2022-05-29

    -   Allow single quotes in atoms

-   1.0.96 - 2022-05-18

    -   Allow non-standard characters in ATOM if it's the string after NO/OK/BAD response

-   1.0.95 - 2022-05-03

    -   Do not use FETCH BINARY, unless `binary` option is `true`

-   1.0.94 - 2022-05-03

    -   Fixed source download

-   1.0.93 - 2022-05-03

    -   Fixed missing unicode encoding for APPEND, COPY, MOVE

-   1.0.92 - 2022-05-03

    -   Added support for IMAP BINARY extension (rfc3516)
    -   Logging improvements

-   1.0.91 - 2022-05-02

    -   Do not throw if literal includes a null byte
    -   Use UTF8 path names by default
    -   Overrides '\*' range query with the EXISTS value

-   1.0.90 - 2022-04-04

    -   Added new configuration option `maxIdleTime`

-   1.0.89 - 2022-04-04

    -   Added new event type `response` that emits all command responses

-   1.0.88 - 2022-03-24

    -   Fixed folder name match where not all non-ascii characters triggered UTF encoding

-   1.0.87 - 2022-03-21

    -   If LIST failed then do not suppress exception

-   1.0.86 - 2022-03-14

    -   Do not try to decode mailbox path from utf7 as methods expect utf-8 not utf-7

-   1.0.85 - 2022-02-23

    -   Trim null bytes in the beginning of IMAP responses to deal with a buggy server that pads responses with null bytes

-   1.0.84 - 2022-02-17

    -   QRESYNC tweaks

-   1.0.83 - 2022-02-16

    -   QRESYNC tweaks

-   1.0.82 - 2022-02-15

    -   Added extra option `expungeHandler`

-   1.0.81 - 2022-02-15

    -   Added support for the QRESYNC extension and untagged VANISHED responses

-   1.0.80 - 2022-02-07

    -   Added support for the missing NOMODSEQ mailbox modifier

-   1.0.79 - 2021-12-29

    -   Added property `greeting` that contains that first response from the server

-   1.0.78 - 2021-11-28

    -   Proxy support. Use configuration options `proxy: "url"` to use proxies

-   1.0.77 - 2021-11-25

    -   Testing out proxy connections
    -   Add X-GM-RAW support for search (jhi721 #68)

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
