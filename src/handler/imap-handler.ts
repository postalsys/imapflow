import parser from './imap-parser.js';
import compiler from './imap-compiler.js';

/**
 * Re-exports the IMAP protocol parser and compiler as a single module.
 *
 * - `parser` parses raw IMAP command/response buffers into structured objects.
 * - `compiler` compiles structured response objects into IMAP protocol Buffers.
 */
export { parser, compiler };
