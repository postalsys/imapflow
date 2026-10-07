// ImapKit (https://github.com/postalsys/imapkit), the in-memory IMAP test server the suites under
// test/imapkit/ run against, ships without type definitions.

declare module 'imapkit' {
    function imapkit(options?: Record<string, any>): any;
    export = imapkit;
}
