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
    } catch (err) {
        // The server declined (NO/BAD): nothing switched, staying uncompressed is safe.
        connection.log.warn({ err, cid: connection.id });
        return false;
    }

    // Everything after the tagged OK is already deflate-framed (RFC 4978 section 4) -
    // the server switches at the OK, so declining the upgrade at this point is not a
    // protocol option. The socket stays piped into the plaintext parser until the
    // transport swaps in the inflater, so bytes that arrived in the same chunk as the
    // OK have been consumed as cleartext and are missing from the head of the deflate
    // stream: the session is unrecoverable in both directions. Fail it immediately
    // (the same way STARTTLS treats post-OK trailing data) instead of letting it die
    // slowly on garbage. Closing this window without failing needs the stream to hand
    // back its unconsumed tail on unpipe so the transport can feed it into the
    // inflater - not something a command module can reach from here.
    if (response.hasTrailingData) {
        let error = new Error('Server sent data between the COMPRESS response and the compression layer switch');
        error.code = 'COMPRESS_TRAILING_DATA';
        connection.log.error({ err: error, cid: connection.id });
        // Schedule the close before releasing parser backpressure, so the buffered
        // deflate-framed bytes cannot settle anything before teardown begins. This is
        // why the decision lives here rather than at the connection layer the way the
        // STARTTLS guard does (starttls.js records a flag, upgradeToSTARTTLS decides):
        // only the command module holds the response before its backpressure release,
        // so only it can order teardown ahead of that release.
        connection.closeAfter();
        response.next();
        throw error;
    }

    response.next();
    return true;
};
