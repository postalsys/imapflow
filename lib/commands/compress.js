'use strict';

/**
 * Requests DEFLATE compression from the server.
 *
 * @param {Object} connection - IMAP connection instance
 * @returns {Promise<boolean>} True if compression was enabled, false otherwise
 */
// COMPRESS=DEFLATE (RFC 4978): enables zlib compression on the IMAP connection
// to reduce bandwidth. Once enabled, all subsequent data in both directions is compressed.
module.exports = async connection => {
    // Skip if the server doesn't support COMPRESS=DEFLATE, or if compression
    // is already active (connection._inflate exists) to avoid double-compression.
    if (!connection.capabilities.has('COMPRESS=DEFLATE') || connection._inflate) {
        // nothing to do here
        return false;
    }

    let response;
    try {
        response = await connection.exec('COMPRESS', [{ type: 'ATOM', value: 'DEFLATE' }]);
        // Everything after the tagged OK is already deflate-framed (RFC 4978 section 4).
        // The socket stays piped into the plaintext parser until this call returns, so
        // bytes that arrived in the same chunk as the OK have been consumed as cleartext
        // and are missing from the head of the deflate stream - the inflater would then
        // fail and take the connection with it. Rare (it needs the server to write again
        // before we re-pipe), and staying uncompressed is a cheaper outcome than a dead
        // connection, so decline the upgrade instead.
        // This only covers the bytes the parser had already buffered when the OK was
        // handled. Closing the remaining window, and keeping compression rather than
        // dropping it, needs the stream to hand back its unconsumed tail on unpipe so
        // the transport can feed it into the inflater - not something a command module
        // can reach from here.
        response.next();
        if (response.hasTrailingData) {
            connection.log.warn({ msg: 'Server sent data immediately after the COMPRESS response, skipping compression', cid: connection.id });
            return false;
        }
        return true;
    } catch (err) {
        connection.log.warn({ err, cid: connection.id });
        return false;
    }
};
