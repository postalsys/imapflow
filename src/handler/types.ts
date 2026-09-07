// Protocol level data shapes shared by the parser, the compiler, the command
// implementations and the connection class.

/**
 * A parsed IMAP token. `type` is one of ATOM, STRING, LITERAL, SEQUENCE, TEXT or
 * NUMBER. A section (`BODY[...]`) and a partial range (`<0.1024>`) are attached to the
 * token they follow.
 */
export interface ImapAttributeNode {
    type: string;
    value?: string | Buffer | number | null | undefined;
    section?: ImapAttributeList | undefined;
    partial?: number[] | undefined;
    /** Redacted from logs and from the raw traffic log when set on an outgoing token */
    sensitive?: boolean | undefined;
    /** Emit the literal as a literal8 (RFC 3516) */
    isLiteral8?: boolean | undefined;
}

/**
 * A parenthesized list of tokens. The token properties are declared as absent so that
 * `entry.value` can be read across the `ImapAttribute` union without narrowing first.
 */
export interface ImapAttributeList extends Array<ImapAttribute> {
    type?: undefined;
    value?: undefined;
    section?: undefined;
    partial?: undefined;
}

/**
 * One attribute of a parsed response: a token, a nested list, or `null` for NIL
 */
export type ImapAttribute = ImapAttributeNode | ImapAttributeList | null;

/**
 * A parsed IMAP response line, or a command being compiled for the wire
 */
export interface ImapResponse {
    /** The IMAP tag: "*" for untagged responses, "+" for continuation requests, or a command tag */
    tag?: string | undefined;
    /** The response or command name, e.g. "OK", "FETCH", or a message sequence number */
    command?: string | undefined;
    /** Parsed attributes of the response */
    attributes?: ImapAttributeList | undefined;
    /** Number of leading NUL bytes stripped from the line, if any */
    nullBytesRemoved?: number | undefined;
}

/**
 * What the command compiler accepts as a node: parsed tokens and lists, and also bare
 * strings, numbers and Buffers, which are written as quoted strings and numbers
 */
export type ImapCompileNode = ImapAttributeNode | string | number | Buffer | null | undefined | false | ImapCompileNode[];

export interface ImapCompileInput {
    tag?: string | undefined;
    command?: string | undefined;
    attributes?: ImapCompileNode | ImapCompileNode[] | undefined;
}

export interface CompilerOptions {
    /** Return an array of Buffers, one per literal segment, instead of a single Buffer */
    asArray?: boolean | undefined;
    /** Redact sensitive values and truncate long strings for logging */
    isLogging?: boolean | undefined;
    /** Use the LITERAL+ extension (non-synchronizing literals of any size) */
    literalPlus?: boolean | undefined;
    /** Use the LITERAL- extension (non-synchronizing literals up to 4096 bytes) */
    literalMinus?: boolean | undefined;
}

export interface ParserOptions {
    /** Whether the LITERAL+ extension is in use */
    literalPlus?: boolean | undefined;
    /** Pre-parsed literal values extracted from the input stream */
    literals?: Buffer[] | undefined;
    /** Maximum size in bytes of a literal parsed inline from the input */
    maxLiteralSize?: number | undefined;
}

/**
 * One assembled response as pushed by ImapStream: the line payload, its literals and the
 * backpressure callback that must be called once the response has been processed
 */
export interface ImapStreamItem {
    payload: Buffer;
    literals: Buffer[];
    next: () => void;
    /** Whether more buffered input already followed this response on the wire */
    trailingAfterLine: boolean;
    /** Set once `next` has been called, see ImapFlow#releaseStreamData */
    released?: boolean | undefined;
}

/**
 * The SELECT or EXAMINE command that opened the current mailbox, kept so fallback polling
 * can re-select the mailbox with the same access mode
 */
export interface SelectCommand {
    command: string;
    arguments: ImapCompileNode[];
}
