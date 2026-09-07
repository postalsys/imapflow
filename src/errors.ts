import type { ImapResponse } from './handler/types.js';

/**
 * An Error raised by ImapFlow, with the extra properties the library attaches to describe
 * the failure. Every property is optional: which ones are present depends on where the
 * error came from.
 */
export interface ImapFlowError extends Error {
    /** Error code, e.g. 'NoConnection', 'ETIMEOUT', 'LockTimeout' or a parser error code */
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
