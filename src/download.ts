// The download() and downloadMany() implementations of ImapFlow. Both are built on the public
// fetchOne(): download() streams a message or one body part through the decoding pipeline,
// fetching it in chunks, and downloadMany() buffers several body parts from one FETCH.

import { PassThrough, type Readable, type Transform } from 'node:stream';
import libmime from 'libmime';
import libqp from 'libqp';
import libbase64 from 'libbase64';
import { Headers } from '@zone-eu/mailsplit';
import FlowedDecoder from '@zone-eu/mailsplit/lib/flowed-decoder.js';

import { LimitedPassthrough, normalizeByteLimit } from './limited-passthrough.js';
import type { ImapFlowError } from './errors.js';
import { getDecoder, isUnsafeKey } from './tools.js';
import type { ImapFlow } from './imap-flow.js';
import type {
    DownloadManyOptions,
    DownloadManyResult,
    DownloadMeta,
    DownloadNotFound,
    DownloadObject,
    DownloadOptions,
    FetchMessageObject,
    FetchOptions,
    FetchQueryObject,
    MessageStructureObject,
    SequenceString
} from './types.js';

/**
 * Implements ImapFlow.download(), see its documentation
 *
 * @param client - Connection to download from
 * @param range - UID or sequence number of the message
 * @param part - Body part to download, the whole message when not set
 * @param options - Download options
 * @returns The download, or an empty object when there is nothing to download
 */
export async function downloadMessage(
    client: ImapFlow,
    range: SequenceString,
    part?: string | undefined,
    options?: DownloadOptions | undefined
): Promise<DownloadObject | DownloadNotFound> {
    if (!client.mailbox) {
        // no mailbox selected, nothing to do
        return {};
    }

    let downloadOptions: DownloadOptions & FetchOptions = Object.assign(
        {
            chunkSize: 64 * 1024,
            maxBytes: Infinity
        },
        options || {}
    );

    let hasMore = true;
    let processed = 0;

    let chunkSize = Number(downloadOptions.chunkSize) || 64 * 1024;
    // Normalized once here so every bounded stage of the pipeline below agrees on the budget
    let maxBytes = normalizeByteLimit(downloadOptions.maxBytes);

    let uid: number | false = false;

    if (part === '1') {
        // Special handling for part "1": in single-node emails (no childNodes),
        // the body is accessed via "TEXT" rather than "1", and headers via
        // "HEADER" instead of "1.MIME". Check bodyStructure to detect this.
        let response = await client.fetchOne(range, { uid: true, bodyStructure: true }, downloadOptions);

        if (!response) {
            return {};
        }

        if (!uid && response.uid) {
            uid = response.uid;
            // force UID from now on even if first range was a sequence number
            range = uid;
            downloadOptions.uid = true;
        }

        if (!(response.bodyStructure as MessageStructureObject).childNodes) {
            // single text message
            part = 'TEXT';
        }
    }

    interface PartResult {
        response?: FetchMessageObject | false | undefined;
        chunk?: Buffer | false | undefined;
        mime?: Buffer | undefined;
    }

    let getNextPart = async (query?: FetchQueryObject | undefined): Promise<PartResult> => {
        query = query || {};

        let mimeKey: string | undefined;

        if (!part) {
            query.source = {
                start: processed,
                maxLength: chunkSize
            };
        } else {
            part = part.toString().toLowerCase().trim();

            if (!query.bodyParts) {
                query.bodyParts = [];
            }

            if (query.size) {
                if (/^[\d.]+$/.test(part)) {
                    // fetch meta as well
                    mimeKey = part + '.mime';
                    query.bodyParts.push(mimeKey);
                } else if (part === 'text') {
                    mimeKey = 'header';
                    query.bodyParts.push(mimeKey);
                }
            }

            query.bodyParts.push({
                key: part,
                start: processed,
                maxLength: chunkSize
            });
        }

        let response = await client.fetchOne(range, query, downloadOptions);

        if (!response) {
            return { response: false, chunk: false };
        }

        if (!uid && response.uid) {
            uid = response.uid;
            // force UID from now on even if first range was a sequence number
            range = uid;
            downloadOptions.uid = true;
        }

        let chunk = !part ? response.source : response.bodyParts && response.bodyParts.get(part);
        if (!chunk) {
            return {};
        }

        processed += chunk.length;
        // A compliant server returns at most `chunkSize` bytes for a partial
        // request. Some servers (Tencent Exmail among them) ignore the partial
        // spec and answer every request with the complete part. That chunk is
        // then larger than requested, so treating it as "full, keep going"
        // would advance the offset past the end forever and never see a short
        // chunk. An oversized answer already contains the whole part - stop.
        hasMore = chunk.length === chunkSize;

        if (chunk.length > chunkSize) {
            client.log.warn({
                msg: 'Server returned more than the requested window, treating the part as complete',
                chunkSize,
                received: chunk.length,
                processed,
                cid: client.id
            });
        }

        let result: PartResult = { chunk };
        if (query.size) {
            result.response = response;
        }

        if (query.bodyParts) {
            if (mimeKey === 'header') {
                result.mime = response.headers;
            } else {
                result.mime = response.bodyParts && mimeKey ? response.bodyParts.get(mimeKey) : undefined;
            }
        }

        return result;
    };

    let { response, chunk, mime } = await getNextPart({
        size: true,
        uid: true
    });

    if (!response || !chunk) {
        // the message or the part does not exist
        return {};
    }

    let meta: DownloadMeta = {
        expectedSize: response.size
    };

    if (!part) {
        meta.contentType = 'message/rfc822';
    } else if (mime) {
        let headers = new Headers(mime);
        let contentType = libmime.parseHeaderValue(headers.getFirst('Content-Type'));
        let transferEncoding = libmime.parseHeaderValue(headers.getFirst('Content-Transfer-Encoding'));
        let disposition = libmime.parseHeaderValue(headers.getFirst('Content-Disposition'));

        if (contentType.value.toLowerCase().trim()) {
            meta.contentType = contentType.value.toLowerCase().trim();
        }

        if (contentType.params.charset) {
            meta.charset = contentType.params.charset.toLowerCase().trim();
        }

        if (transferEncoding.value) {
            meta.encoding = transferEncoding.value
                .replace(/\(.*\)/g, '')
                .toLowerCase()
                .trim();
        }

        if (disposition.value) {
            /* c8 ignore next */ // a parsed disposition value is never all-whitespace, so the `false` fallback is unreachable
            meta.disposition = disposition.value.toLowerCase().trim() || false;
            try {
                meta.disposition = libmime.decodeWords(meta.disposition as string);
            } catch {
                // failed to parse disposition, keep as is (most probably an unknown charset is used)
            }
        }

        if (contentType.params.format && contentType.params.format.toLowerCase().trim() === 'flowed') {
            meta.flowed = true;
            if (contentType.params.delsp && contentType.params.delsp.toLowerCase().trim() === 'yes') {
                meta.delSp = true;
            }
        }

        let filename = disposition.params.filename || contentType.params.name || false;
        if (filename) {
            try {
                filename = libmime.decodeWords(filename);
            } catch {
                // failed to parse filename, keep as is (most probably an unknown charset is used)
            }
            meta.filename = filename;
        }
    }

    let stream: Transform;
    let output: Transform;
    let fetchAborted = false;

    // Build a decoder pipeline that progressively transforms the raw FETCH data:
    //   1. Transfer-encoding decoder (base64 or quoted-printable -> binary)
    //   2. Format decoder (format=flowed -> plain text, if applicable)
    //   3. Charset decoder (non-UTF-8 -> UTF-8, for text parts only)
    //   4. Byte limiter (enforces maxBytes cap)
    // `stream` is the head of the pipeline (where raw chunks are written),
    // `output` is the tail (what the caller reads from).
    // Parts that arrived via FETCH BINARY (response.binaryParts) are already
    // decoded by the server - decoding again would corrupt the data, so stage 1
    // is skipped for them.
    let clientEncoding = response.binaryParts && part && response.binaryParts.has(part) ? false : meta.encoding;
    switch (clientEncoding) {
        case 'base64':
            output = stream = new libbase64.Decoder();
            break;
        case 'quoted-printable':
            output = stream = new libqp.Decoder();
            break;
        default:
            output = stream = new PassThrough();
    }

    // Every byte-bounded stage of the pipeline. The fetch loop below stops as soon as any of
    // them has taken all it will accept. The limiter at the tail is not enough on its own: a
    // transform in the middle that buffers its whole input before emitting anything (the
    // format=flowed decoder, the Japanese charset decoder) leaves the tail limiter reporting
    // `limited === false` however much the server sends, so a download with a small maxBytes
    // would still pull the entire part off the wire.
    let limiters: Array<{ limited?: boolean | undefined }> = [];
    let isLimited = () => limiters.some(entry => entry.limited);

    // Appending a stage means forwarding the current tail's errors to it before piping, so a
    // failure anywhere reaches the stream the caller is reading
    let pipeStage = <T extends Transform>(stage: T): T => {
        output.on('error', err => {
            stage.emit('error', err);
        });
        output = output.pipe(stage);
        return stage;
    };

    let isTextNode = ['text/html', 'text/plain', 'text/x-amp-html'].includes(meta.contentType as string) || (part === '1' && !meta.contentType);
    if ((!meta.disposition || meta.disposition === 'inline') && isTextNode) {
        // RFC 3676 format=flowed text: unwrap soft line breaks
        if (meta.flowed) {
            // FlowedDecoder buffers its whole input before emitting, and being third party it
            // carries no bound of its own, so bound what it can ever be handed. Unwrapping only
            // removes bytes, so capping its input at maxBytes cannot push the delivered output
            // above the cap either.
            limiters.push(pipeStage(new LimitedPassthrough({ maxBytes })));

            pipeStage(new FlowedDecoder(meta.delSp ? { delSp: true } : {}) as unknown as Transform);
        }

        // Convert non-UTF-8 charsets to UTF-8 via a streaming decoder.
        // ASCII and UTF-8 need no conversion. Unknown charsets are left as-is.
        if (meta.charset && !['ascii', 'usascii', 'utf8'].includes(meta.charset.toLowerCase().replace(/[^a-z0-9]+/g, ''))) {
            try {
                let decoder = getDecoder(meta.charset, maxBytes);
                // Safety listener attached first so the decoder always has at least
                // one 'error' listener. Prevents Node.js from throwing
                // ERR_UNHANDLED_ERROR if a later pipe setup step throws and leaves
                // the source-forwarding closure attached without a downstream
                // listener wired up. Any real listener the caller attaches still
                // fires in addition to this one.
                decoder.on('error', err => {
                    client.log.warn({ err, charset: meta.charset, cid: client.id });
                });
                // The Japanese decoder buffers its whole input as well, and reports the same
                // `limited` flag the limiters do so the fetch loop can stop once it is full.
                // A streaming decoder has no such flag, which reads as false and is correct.
                limiters.push(pipeStage(decoder));
                // force to utf-8 for output
                meta.charset = 'utf-8';
            } catch {
                // do not decode charset
            }
        }
    }

    let limiter = pipeStage(new LimitedPassthrough({ maxBytes }));
    limiters.push(limiter);

    // Cleanup function
    const cleanup = () => {
        fetchAborted = true;
        if (stream && !stream.destroyed) {
            stream.destroy();
        }
    };

    // Listen for stream destruction
    output.once('error', cleanup);
    output.once('close', cleanup);

    let writeChunk = (chunk: Buffer): boolean => {
        if (isLimited() || fetchAborted || stream.destroyed) {
            return true;
        }
        return stream.write(chunk);
    };

    // Ceiling on how many bytes one download may pull off the wire, as the backstop for the
    // partial-ignoring servers above: a part whose size happens to equal chunkSize exactly
    // comes back looking like a full window every time, so no test over chunk lengths can end
    // that loop. RFC822.SIZE bounds any part of the message; doubled for servers that count
    // line endings differently than they deliver, plus one window so a download sitting right
    // at the bound still gets its terminating chunk. Infinity when the server reported no
    // size, which leaves the loop bounded by maxBytes alone.
    let maxTotalBytes = normalizeByteLimit(meta.expectedSize ? meta.expectedSize * 2 + chunkSize : 0);

    // Fetch remaining chunks in a loop, writing each to the decoder stream.
    // Stops when the server returns a short chunk (< chunkSize), answers with more than the
    // requested window, the byte limiter is satisfied, or the consumer destroys the output
    // stream. Throws when the ceiling above is crossed.
    let fetchAllParts = async () => {
        while (hasMore && !isLimited() && !fetchAborted) {
            if (processed >= maxTotalBytes) {
                // Loud on purpose. Everything written downstream by this point holds
                // duplicated content, and a quiet stop is indistinguishable from a clean EOF,
                // so the consumer would store a corrupt body believing it intact.
                let err: ImapFlowError = new Error('Download exceeded the expected message size');
                err.code = 'DownloadOverflow';
                err.maxSize = maxTotalBytes;
                err.cid = client.id;
                throw err;
            }

            let { response, chunk } = await getNextPart();
            if (fetchAborted) {
                break;
            }

            if (response === false) {
                // The message is gone mid-download (expunged by another client, or the
                // mailbox was closed). Ending the stream here would pass the truncated body
                // off as complete, so the consumer is told the same way as for an overflow.
                let err: ImapFlowError = new Error('Message disappeared before the download completed');
                err.code = 'DownloadIncomplete';
                err.cid = client.id;
                throw err;
            }

            if (!chunk) {
                break;
            }

            // Handle backpressure
            if (writeChunk(chunk) === false) {
                // Wait for drain event before continuing
                try {
                    await new Promise<void>((resolve, reject) => {
                        // finish() is the listener itself, as settle() is for the TLS upgrade:
                        // 'drain' and 'close' emit no arguments, 'error' emits the error, and
                        // removal needs no separate handler references. It removes only the
                        // three listeners this wait installed - removeAllListeners('error')
                        // also took off the forwarder pipeStage() attached to the head stream
                        // when the pipeline was built, and the head must keep that forwarder
                        // for the life of the download or a chunk failure has nowhere to go.
                        const finish = (err?: Error | undefined) => {
                            for (let event of ['drain', 'error', 'close']) {
                                stream.removeListener(event, finish);
                            }

                            /* c8 ignore next 2 */ // stream error during a backpressure drain wait is timing-dependent
                            if (err) {
                                reject(err);
                            } else {
                                resolve();
                            }
                        };

                        stream.once('drain', finish);
                        stream.once('error', finish);
                        stream.once('close', finish);
                    });
                    /* c8 ignore start */ // re-throw path only triggers on a stream error mid-drain, which is timing-dependent
                } catch (err) {
                    // Re-throw only if not aborted
                    if (!fetchAborted) {
                        throw err;
                    }
                }
                /* c8 ignore stop */

                // Check if we should abort after waiting
                if (fetchAborted) {
                    break;
                }
            }
        }
    };

    // A download is a sequence of chunk FETCHes with a backpressure wait in between. Those
    // gaps look exactly like an inactive connection, so without this auto-IDLE would start
    // between chunks and the next chunk would have to break it again - two extra round
    // trips per chunk, for as long as the consumer is slow. Counted before control returns
    // to the event loop: the head chunk's own FETCH already armed the auto-IDLE timer, and
    // with a very short autoIdleDelay that timer could otherwise fire before the deferred
    // chunk loop below has marked the download open.
    client._openDownloads++;
    let downloadDone = false;
    let finishDownload = () => {
        if (!downloadDone) {
            downloadDone = true;
            client._openDownloads--;
            client.autoidle();
        }
    };

    // Kick off the download pipeline asynchronously. The first chunk was
    // already fetched above (to get metadata); write it to the decoder
    // stream and then fetch remaining chunks via fetchAllParts().
    // setImmediate ensures the caller gets the {meta, content} return
    // value before streaming begins.
    let runFetchAllParts = () => {
        fetchAllParts()
            .catch(err => {
                if (!fetchAborted && stream && !stream.destroyed) {
                    stream.emit('error', err);
                    /* c8 ignore start */ // the else logs when a fetch error arrives after the stream was already torn down (timing-dependent)
                } else {
                    // Log when error cannot be emitted to stream
                    client.log.warn({
                        msg: 'Download error after stream closed',
                        err,
                        fetchAborted,
                        streamDestroyed: stream?.destroyed,
                        cid: client.id
                    });
                }
                /* c8 ignore stop */
            })
            .finally(() => {
                finishDownload();
                if (!fetchAborted && stream && !stream.destroyed) {
                    stream.end();
                }
            })
            // Terminal guard: nothing consumes this chain, so a throw from either handler
            // above rejects a promise nobody holds and takes the process down on
            // unhandledRejection. Reaching it always means an invariant broke - the head
            // stream kept pipeStage()'s error forwarder for the life of the download, so
            // emit('error') above has somewhere to go - which is why it logs at error even
            // for a routine-looking connection code.
            .catch(err => client.log.error({ msg: 'Failed to fail the download stream', err, cid: client.id }));
    };

    setImmediate(() => {
        let writeResult;
        try {
            writeResult = writeChunk(chunk);
        } catch (err) {
            stream.emit('error', err);
            finishDownload();
            /* c8 ignore next 3 */ // emitting the error above triggers cleanup (fetchAborted=true), so this end() guard is already false here
            if (!fetchAborted && stream && !stream.destroyed) {
                stream.end();
            }
            return;
        }

        /* c8 ignore next 9 */ // `stream` is piped to the limiter before this runs, so the head write drains synchronously and always returns true (verified for chunkSize up to 8MB); the drain-wait branch is unreachable
        if (!writeResult) {
            // Initial chunk filled the buffer, wait for drain
            stream.once('drain', () => {
                if (!fetchAborted) {
                    runFetchAllParts();
                } else {
                    finishDownload();
                }
            });
        } else {
            runFetchAllParts();
        }
    });

    return {
        meta,
        content: output as Readable
    };
}

/**
 * Implements ImapFlow.downloadMany(), see its documentation
 *
 * @param client - Connection to download from
 * @param range - UID or sequence number of the message
 * @param parts - Body parts to download
 * @param options - Download options
 * @returns Downloaded parts keyed by part number
 */
export async function downloadMessageParts(
    client: ImapFlow,
    range: SequenceString,
    parts: string[],
    options?: DownloadManyOptions | undefined
): Promise<DownloadManyResult> {
    if (!client.mailbox) {
        // no mailbox selected, nothing to do
        return {};
    }

    let downloadOptions: DownloadManyOptions & FetchOptions = Object.assign(
        {
            chunkSize: 64 * 1024,
            maxBytes: Infinity
        },
        options || {}
    );

    let query: FetchQueryObject & { bodyParts: string[] } = { bodyParts: [] };

    for (let part of parts) {
        query.bodyParts.push(part + '.mime');
        query.bodyParts.push(part);
    }

    let response = await client.fetchOne(range, query, downloadOptions);

    if (!response || !response.bodyParts) {
        return {};
    }

    let data: { [part: string]: { meta?: DownloadMeta | undefined; content?: Buffer | null | undefined } } = {};

    for (let [part, content] of response.bodyParts) {
        let keyParts = part.split('.mime');
        // The server chooses the BODY[...] keys it answers with: never let one be a
        // prototype-chain name, or the assignments below write onto Object.prototype
        // (process-wide pollution) instead of the result object.
        if (isUnsafeKey(keyParts[0])) {
            continue;
        }
        if (keyParts.length === 1) {
            // content
            let key = keyParts[0] as string;
            if (!data[key]) {
                data[key] = { content };
            } else {
                data[key].content = content;
            }
        } else if (keyParts.length === 2) {
            // header
            let key = keyParts[0] as string;
            if (!data[key]) {
                data[key] = {};
            }
            let entry = data[key];
            if (!entry.meta) {
                entry.meta = {};
            }
            let meta = entry.meta;

            let headers = new Headers(content);
            let contentType = libmime.parseHeaderValue(headers.getFirst('Content-Type'));
            let transferEncoding = libmime.parseHeaderValue(headers.getFirst('Content-Transfer-Encoding'));
            let disposition = libmime.parseHeaderValue(headers.getFirst('Content-Disposition'));

            if (contentType.value.toLowerCase().trim()) {
                meta.contentType = contentType.value.toLowerCase().trim();
            }

            if (contentType.params.charset) {
                meta.charset = contentType.params.charset.toLowerCase().trim();
            }

            if (transferEncoding.value) {
                meta.encoding = transferEncoding.value
                    .replace(/\(.*\)/g, '')
                    .toLowerCase()
                    .trim();
            }

            if (disposition.value) {
                /* c8 ignore next */ // a parsed disposition value is never all-whitespace, so the `false` fallback is unreachable
                meta.disposition = disposition.value.toLowerCase().trim() || false;
                try {
                    meta.disposition = libmime.decodeWords(meta.disposition as string);
                } catch {
                    // failed to parse disposition, keep as is (most probably an unknown charset is used)
                }
            }

            if (contentType.params.format && contentType.params.format.toLowerCase().trim() === 'flowed') {
                meta.flowed = true;
                if (contentType.params.delsp && contentType.params.delsp.toLowerCase().trim() === 'yes') {
                    meta.delSp = true;
                }
            }

            let filename = disposition.params.filename || contentType.params.name || false;
            if (filename) {
                try {
                    filename = libmime.decodeWords(filename);
                } catch {
                    // failed to parse filename, keep as is (most probably an unknown charset is used)
                }
                meta.filename = filename;
            }
        }
    }

    for (let part of Object.keys(data)) {
        let entry = data[part] as { meta?: DownloadMeta | undefined; content?: Buffer | null | undefined };
        // `meta` is only built from the companion BODY[<part>.MIME] item. A server may
        // legally answer with fewer items than were requested, and one part arriving
        // without its MIME headers must not cost the caller the whole download.
        let meta = entry.meta || {};
        entry.meta = meta;

        // parts that arrived via FETCH BINARY (response.binaryParts) are already
        // decoded by the server - decoding again would corrupt the data
        let clientEncoding = response.binaryParts && response.binaryParts.has(part) ? false : meta.encoding;
        switch (clientEncoding) {
            case 'base64':
                entry.content = entry.content ? libbase64.decode(entry.content.toString()) : null;
                break;
            case 'quoted-printable':
                entry.content = entry.content ? libqp.decode(entry.content.toString()) : null;
                break;
            default:
            // keep as is, already a buffer
        }
    }

    return data as DownloadManyResult;
}
