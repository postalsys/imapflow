'use strict';

const parser = require('./imap-parser');
const compiler = require('./imap-compiler');

/**
 * Re-exports the IMAP protocol parser and compiler as a single module.
 *
 * @property {Function} parser - Parses raw IMAP command/response buffers into structured objects.
 *   See {@link module:imap-parser} for details.
 * @property {Function} compiler - Compiles structured response objects into IMAP protocol Buffers.
 *   See {@link module:imap-compiler} for details.
 */
module.exports = {
    parser,
    compiler
};
