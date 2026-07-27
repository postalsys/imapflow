'use strict';

// Shared response-size limits for the IMAP parser. Kept in one place so the streaming parser
// (ImapStream) and the standalone token parser cannot drift apart, and so the documented
// defaults in imap-flow.d.ts describe both paths.

// Maximum allowed literal size: 1GB (1073741824 bytes)
const MAX_LITERAL_SIZE = 1024 * 1024 * 1024;

// Default maximum length of a single line (a response without a literal). Matches the literal cap:
// large literal-free responses (e.g. big SEARCH/LIST results) are legitimate, so this bound exists
// only to stop a server that never sends a line terminator, not to constrain normal traffic.
const MAX_LINE_SIZE = MAX_LITERAL_SIZE;

/**
 * Normalizes a configured size limit. A non-negative integer is honored as-is (including 0, which
 * means "reject anything non-empty"); anything else falls back to the default, so an explicit 0 is
 * not silently swallowed the way `value || DEFAULT` would swallow it.
 *
 * @param {*} value - The configured value.
 * @param {number} defaultValue - Fallback when the value is not a usable limit.
 * @returns {number} The normalized limit.
 */
const normalizeLimit = (value, defaultValue) => (Number.isInteger(value) && value >= 0 ? value : defaultValue);

/**
 * Builds the `LiteralTooLarge` error. One shape for every place a literal is refused, so callers
 * can rely on `code`, `literalSize` and `maxSize` regardless of which parser rejected it.
 *
 * @param {number} literalSize - The declared literal size.
 * @param {number} maxSize - The bound that was exceeded.
 * @param {string} [reason] - What the bound was, when it is not the configured maximum.
 * @returns {Error} The error to emit or throw.
 */
const createLiteralTooLargeError = (literalSize, maxSize, reason) => {
    const err = new Error(`Literal size ${literalSize} exceeds ${reason || `maximum allowed size of ${maxSize} bytes`}`);
    err.code = 'LiteralTooLarge';
    err.literalSize = literalSize;
    err.maxSize = maxSize;
    return err;
};

module.exports = { MAX_LITERAL_SIZE, MAX_LINE_SIZE, normalizeLimit, createLiteralTooLargeError };
