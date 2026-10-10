import type { ImapResponse } from './handler/types.js';

/**
 * The `code` values ImapFlow sets on the errors it raises, so they can be matched without
 * string literals: `if (err.code === ImapFlowErrorCode.NoConnection)`.
 *
 * Parser failures use `ParserError` followed by a number (`ParserError11`) and are not listed
 * one by one, test them with `err.code?.startsWith('ParserError')`. Errors from the socket, TLS
 * or DNS layer pass through with Node's own code (`ECONNREFUSED`, `ENOTFOUND`, ...).
 */
export const ImapFlowErrorCode = {
    // the connection is gone, the command was not (or can no longer be) completed
    NoConnection: 'NoConnection',
    EConnectionClosed: 'EConnectionClosed',
    StateLogout: 'StateLogout',
    ClosedAfterConnectText: 'ClosedAfterConnectText',
    ClosedAfterConnectTLS: 'ClosedAfterConnectTLS',

    // timeouts
    CONNECT_TIMEOUT: 'CONNECT_TIMEOUT',
    GREETING_TIMEOUT: 'GREETING_TIMEOUT',
    UPGRADE_TIMEOUT: 'UPGRADE_TIMEOUT',
    ETIMEOUT: 'ETIMEOUT',
    LockTimeout: 'LockTimeout',

    // the server
    ETHROTTLE: 'ETHROTTLE',
    UnexpectedTag: 'UnexpectedTag',
    InvalidResponse: 'InvalidResponse',
    ResponseProcessingFailed: 'ResponseProcessingFailed',
    STARTTLS_INJECTION: 'STARTTLS_INJECTION',
    COMPRESS_TRAILING_DATA: 'COMPRESS_TRAILING_DATA',
    PollFailed: 'PollFailed',
    NotFound: 'NotFound',
    MissingServerExtension: 'MissingServerExtension',

    // response parsing and size limits
    ParserError: 'ParserError',
    ParserErrorExchange: 'ParserErrorExchange',
    // an unexpected exception inside the parser, re-raised with a code; a parser bug
    ParserErrorInternal: 'ParserErrorInternal',
    MAX_IMAP_NESTING_REACHED: 'MAX_IMAP_NESTING_REACHED',
    LineTooLarge: 'LineTooLarge',
    LiteralTooLarge: 'LiteralTooLarge',
    ResponseTooLarge: 'ResponseTooLarge',

    // invalid values in a command
    InvalidStringValue: 'InvalidStringValue',
    InvalidTokenValue: 'InvalidTokenValue',
    InvalidTextValue: 'InvalidTextValue',
    InvalidSequenceSet: 'InvalidSequenceSet',
    InvalidSearchQuery: 'InvalidSearchQuery',
    InvalidMessageContent: 'InvalidMessageContent',

    // download()
    DownloadOverflow: 'DownloadOverflow',
    DownloadIncomplete: 'DownloadIncomplete',

    // proxy connections
    ProxyError: 'ProxyError',
    EPROXY: 'EPROXY',
    UnsupportedProxyAddress: 'UnsupportedProxyAddress',
    ERR_INVALID_URL: 'ERR_INVALID_URL',

    // API misuse
    InstanceReused: 'InstanceReused'
} as const;

/** One of the {@link ImapFlowErrorCode} values */
export type ImapFlowErrorCode = (typeof ImapFlowErrorCode)[keyof typeof ImapFlowErrorCode];

/** A numbered parser error code, `ParserError1` and up */
export type ParserErrorCode = `ParserError${number}`;

/**
 * An Error raised by ImapFlow, with the extra properties the library attaches to describe
 * the failure. Every property is optional: which ones are present depends on where the
 * error came from.
 */
export interface ImapFlowError extends Error {
    /** Error code, one of {@link ImapFlowErrorCode}, a parser error code or a code from Node */
    code?: string | undefined;
    /** Connection id the error belongs to */
    cid?: string | undefined;
    /** Connection id, stamped by emitError() */
    _connId?: string | undefined;
    /** Which internal site rejected with this error */
    rejectedFrom?: string | undefined;
    /** The command that was affected */
    command?: string | undefined;
    /** The mailbox path that was affected */
    path?: string | undefined;
    /** Status of the tagged response that failed the command: 'NO' or 'BAD' */
    responseStatus?: string | undefined;
    /** Human readable text of the failed tagged response */
    responseText?: string | undefined;
    /** The server response: the parsed response, or its text once enhanceCommandError() ran */
    response?: ImapResponse | string | false | undefined;
    /** Response code of the failed tagged response, e.g. 'AUTHENTICATIONFAILED' */
    serverResponseCode?: string | undefined;
    /** The command as it was sent, for logging */
    executedCommand?: string | undefined;
    /** Set when authentication failed */
    authenticationFailed?: boolean | undefined;
    /** Set when a TLS or STARTTLS upgrade failed */
    tlsFailed?: boolean | undefined;
    /** Server suggested back-off in milliseconds for an ETHROTTLE error */
    throttleReset?: number | undefined;
    /** Milliseconds of the ETHROTTLE back-off the connection already waited before rejecting */
    throttleWaited?: number | undefined;
    /** Additional details, e.g. the timeouts that applied */
    details?: { [key: string]: any } | undefined;
    /** The underlying error */
    _err?: Error | undefined;
    /** Server BYE reason */
    reason?: string | undefined;
    /** Set when a mailbox could not be selected because it does not exist */
    mailboxMissing?: boolean | undefined;
    /** Id of the mailbox lock that timed out */
    lockId?: number | undefined;
    /** The parser error that failed a command completion */
    parserError?: ImapFlowError | undefined;
    /** Parser diagnostics */
    parserContext?: { [key: string]: any } | undefined;
    /** The tag the parser had already read before it failed */
    parsedTag?: string | undefined;
    /** The declared size of a rejected literal */
    literalSize?: number | undefined;
    /** The length of a rejected line */
    lineLength?: number | undefined;
    /** The size of a rejected response */
    responseSize?: number | undefined;
    /** The bound that was exceeded */
    maxSize?: number | undefined;
    /** OAuth error details from the server, for XOAUTH2 authentication failures */
    oauthError?: any;
    /** The IMAP string that could not be parsed */
    _imapStr?: string | undefined;
}

/**
 * The fields a connection error is stamped with to say where it was rejected, see
 * buildConnectionError() in tools.ts
 */
export type ConnectionErrorSite = Pick<ImapFlowError, 'rejectedFrom' | 'command' | 'path'>;

/**
 * Error subclass thrown when IMAP authentication fails.
 */
export class AuthenticationFailure extends Error implements ImapFlowError {
    authenticationFailed = true as const;
    declare serverResponseCode?: string | undefined;
    /** Text of the server's error response */
    declare response?: string | undefined;
    declare oauthError?: any;
}

/**
 * Creates an {@link ImapFlowError} with a code and optional extra properties. The code is
 * checked by the compiler against {@link ImapFlowErrorCode}, so a typo or an undeclared
 * code fails the build instead of reaching consumers.
 *
 * @param message - The error message
 * @param code - The error code
 * @param props - Extra properties to set on the error
 * @returns The error, ready to throw or reject with
 */
export function createImapError(
    message: string,
    code: ImapFlowErrorCode | ParserErrorCode,
    props?: Omit<ImapFlowError, 'name' | 'message' | 'stack' | 'code'> | undefined
): ImapFlowError {
    const error: ImapFlowError = new Error(message);
    error.code = code;
    if (props) {
        Object.assign(error, props);
    }
    return error;
}
