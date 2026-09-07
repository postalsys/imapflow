// Shared response-size limits for the IMAP parser. Kept in one place so the streaming parser
// (ImapStream) and the standalone token parser cannot drift apart, and so the documented
// defaults in the ImapFlowOptions type describe both paths.

import type { ImapFlowError } from '../errors.js';

// Maximum allowed literal size: 1GB (1073741824 bytes)
export const MAX_LITERAL_SIZE = 1024 * 1024 * 1024;

// Default maximum length of a single line (a response without a literal). Matches the literal cap:
// large literal-free responses (e.g. big SEARCH/LIST results) are legitimate, so this bound exists
// only to stop a server that never sends a line terminator, not to constrain normal traffic.
export const MAX_LINE_SIZE = MAX_LITERAL_SIZE;

// Default maximum total size of a single assembled response: every line segment and literal of
// one response combined. The per-line and per-literal caps alone cannot stop a server that
// spreads attacker-controlled bytes across an unbounded number of tokens of a single response
// (e.g. one FETCH answer carrying many maximum-size literals).
//
// Deliberately above the literal cap: the response total also carries the literal's marker line
// and the rest of the response framing, so a cap equal to MAX_LITERAL_SIZE would make a literal
// of exactly the maximum permitted size impossible to receive. Configuring both limits calls for
// the same headroom - set maxResponseSize above maxLiteralSize, not equal to it.
export const MAX_RESPONSE_SIZE = 2 * MAX_LITERAL_SIZE;

/**
 * Normalizes a configured size limit. A non-negative integer is honored as-is (including 0, which
 * means "reject anything non-empty"), and `Infinity` disables the limit; anything else falls back
 * to the default, so an explicit 0 is not silently swallowed the way `value || DEFAULT` would
 * swallow it.
 *
 * @param value - The configured value.
 * @param defaultValue - Fallback when the value is not a usable limit.
 * @returns The normalized limit.
 */
export const normalizeLimit = (value: unknown, defaultValue: number): number =>
    (Number.isInteger(value) || value === Infinity) && (value as number) >= 0 ? (value as number) : defaultValue;

/**
 * Builds the `LiteralTooLarge` error. One shape for every place a literal is refused, so callers
 * can rely on `code`, `literalSize` and `maxSize` regardless of which parser rejected it.
 *
 * @param literalSize - The declared literal size.
 * @param maxSize - The bound that was exceeded.
 * @param reason - What the bound was, when it is not the configured maximum.
 * @returns The error to emit or throw.
 */
export const createLiteralTooLargeError = (literalSize: number, maxSize: number, reason?: string | null | undefined): ImapFlowError => {
    const err: ImapFlowError = new Error(`Literal size ${literalSize} exceeds ${reason || `maximum allowed size of ${maxSize} bytes`}`);
    err.code = 'LiteralTooLarge';
    err.literalSize = literalSize;
    err.maxSize = maxSize;
    return err;
};
