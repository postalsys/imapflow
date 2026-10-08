// The download() and downloadMany() implementations of ImapFlow. Both are built on the public
// fetchOne(): download() streams a message or one body part through the decoding pipeline,
// fetching it in chunks, and downloadMany() buffers several body parts from one FETCH.

import { PassThrough, type Transform } from 'node:stream';
import libmime from 'libmime';
import libqp from 'libqp';
import libbase64 from 'libbase64';
import { Headers } from '@zone-eu/mailsplit';
import FlowedDecoder from '@zone-eu/mailsplit/lib/flowed-decoder.js';

import { LimitedPassthrough, normalizeByteLimit } from './limited-passthrough.js';

// What a wait on the head stream listens for: it can take more input, it failed, or it went
// away (a consumer destroying it closes it without a 'drain')
const DRAIN_WAIT_EVENTS = ['drain', 'error', 'close'];
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
    SequenceString
} from './types.js';

type BodyPartRequest = NonNullable<FetchQueryObject['bodyParts']>[number];

const isEmptySection = (value: Buffer | undefined): boolean => !value?.length;

/**
 * The section to ask again when exactly one of a part's MIME headers and content came back
 * empty (see refetchDroppedSections()), undefined when both or neither did
 */
const droppedSection = (
    mime: Buffer | undefined,
    content: Buffer | undefined,
    mimeRequest: BodyPartRequest,
    contentRequest: BodyPartRequest
): BodyPartRequest | undefined => {
    if (isEmptySection(mime) === isEmptySection(content)) {
        return undefined;
    }
    return isEmptySection(content) ? contentRequest : mimeRequest;
};

/** Start offset of every partial section among the requests, keyed by section */
const partialStarts = (requests: BodyPartRequest[]): Map<string, number> => {
    let starts = new Map<string, number>();
    for (let request of requests) {
        if (typeof request !== 'string') {
            starts.set(request.key, Number(request.start) || 0);
        }
    }
    return starts;
};

// Attempts per request when the answer belongs to another request or, for a message known to
// exist, is empty
const MAX_FETCH_ATTEMPTS = 3;

/** What an answer must match to be taken as the answer to a request */
interface ExpectedAnswer {
    /** UID of the message, when the request addressed it by UID */
    uid?: number | undefined;
    /** Start offset of every partial section asked, keyed like bodyParts ('' for the whole message) */
    origins: Map<string, number>;
    /** True while an empty answer should be asked again: the message is known to exist (an
     * earlier answer had it) and the data is still wanted */
    retryEmpty?: (() => boolean) | undefined;
}

const requestedUid = (range: SequenceString | number, options: FetchOptions): number | undefined =>
    options.uid && /^\d+$/.test(String(range)) ? Number(range) : undefined;

const isForeignAnswer = (response: FetchMessageObject, expected: ExpectedAnswer): boolean => {
    if (expected.uid && response.uid && response.uid !== expected.uid) {
        return true;
    }
    for (let [key, start] of expected.origins) {
        let origin = response.partialOrigins && response.partialOrigins.get(key);
        // An answer without the origin is taken as is: some servers leave it out, and some
        // ignore the partial specifier altogether
        if (typeof origin === 'number' && origin !== start) {
            return true;
        }
    }
    return false;
};

/**
 * fetchOne() that takes only an answer belonging to the request. Apache James now and then
 * writes the head of a FETCH answer after its tagged OK, so the data of one request shows up
 * within the answer to the next one. Taken at face value it would be the data of that next
 * request, and a download would end without an error but with misplaced bytes. An answer for
 * another UID, or with a partial section that starts at another offset than asked, is dropped
 * and the request repeated. An empty answer is repeated too while `expected.retryEmpty()` says
 * the message exists, as the data of a late answer arrives with the repeated request.
 */
async function fetchExpected(
    client: ImapFlow,
    range: SequenceString | number,
    query: FetchQueryObject,
    options: FetchOptions,
    expected: ExpectedAnswer
): Promise<FetchMessageObject | false | undefined> {
    for (let attempt = 1; ; attempt++) {
        let response = await client.fetchOne(range, query, options);
        if (response === false && expected.retryEmpty && expected.retryEmpty() && attempt < MAX_FETCH_ATTEMPTS) {
            // The answer may come late instead (after the tagged OK, with the next answer), then
            // it shows up in the answer to the repeated request. A message that is really gone
            // answers empty every time, and the caller reports it.
            client.log.warn({ msg: 'Server answered a request for an existing message with no data, asking again', attempt, cid: client.id });
            continue;
        }
        if (!response || !isForeignAnswer(response, expected)) {
            return response;
        }
        client.log.warn({
            msg: 'Server answered with data of another request, asking again',
            uid: response.uid,
            origins: response.partialOrigins && Object.fromEntries(response.partialOrigins),
            attempt,
            cid: client.id
        });
        if (attempt >= MAX_FETCH_ATTEMPTS) {
            let err: ImapFlowError = new Error('Server kept answering with data of another request');
            err.code = 'DownloadIncomplete';
            err.cid = client.id;
            throw err;
        }
    }
}

/**
 * Apache James (and the servers built on it, Twake Mail among them) answers only the first
 * section it is asked for each MIME part of one FETCH and returns the other one empty:
 * BODY[2.MIME] with BODY[2] yields the headers and a zero-length body, the reverse order loses
 * the headers (FetchGroup.addPartContent() keeps the first descriptor for a part path). Asks the
 * sections that came back empty again, in a FETCH of their own, and merges the answer into
 * `response`. Callers only list a section whose companion did arrive, so a compliant server
 * pays the extra round trip only for a part that really is empty.
 */
async function refetchDroppedSections(
    client: ImapFlow,
    response: FetchMessageObject,
    range: SequenceString | number,
    options: FetchOptions,
    sections: BodyPartRequest[]
): Promise<void> {
    if (!sections.length) {
        return;
    }

    client.log.debug({
        msg: 'Server answered a body section empty while its companion section was not, asking it again separately',
        sections: sections.map(section => (typeof section === 'string' ? section : section.key)),
        cid: client.id
    });

    // the UID pins the message even when the first command addressed it by sequence number
    let uid = response.uid;
    let retry = await fetchExpected(client, uid || range, { uid: true, bodyParts: sections }, uid ? { ...options, uid: true } : options, {
        uid,
        origins: partialStarts(sections),
        retryEmpty: () => true
    });
    if (!retry) {
        return;
    }

    if (retry.headers) {
        response.headers = retry.headers;
    }
    for (let [key, value] of retry.bodyParts || []) {
        (response.bodyParts ??= new Map()).set(key, value);
        if (retry.binaryParts && retry.binaryParts.has(key)) {
            (response.binaryParts ??= new Set()).add(key);
        } else if (response.binaryParts) {
            response.binaryParts.delete(key);
        }
    }
}

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

    let downloadOptions: DownloadOptions = Object.assign(
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
        let expectedUid = requestedUid(range, downloadOptions);
        let response = await fetchExpected(client, range, { uid: true, bodyStructure: true }, downloadOptions, {
            uid: expectedUid,
            origins: new Map(),
            // a message addressed by UID is taken to exist, see getNextPart() below
            retryEmpty: expectedUid ? () => true : undefined
        });

        if (!response) {
            return {};
        }

        if (!uid && response.uid) {
            uid = response.uid;
            // force UID from now on even if first range was a sequence number
            range = uid;
            downloadOptions.uid = true;
        }

        // bodyStructure is unset when the server sent BODYSTRUCTURE NIL
        if (!response.bodyStructure?.childNodes) {
            // single text message
            part = 'TEXT';
        }
    }

    // The decoder pipeline, built once the head chunk told what the part is (see below)
    let stream: Transform;
    let output: Transform;
    let fetchAborted = false;
    // A consumer that gave up: its 'close' may still be a tick away from setting fetchAborted,
    // so the stream's own flag is checked as well
    // `output` is unset until the head chunk is in, and the head chunk's retry asks already
    let downloadAborted = () => fetchAborted || !!output?.destroyed;

    interface PartResult {
        response?: FetchMessageObject | false | undefined;
        chunk?: Buffer | false | undefined;
        mime?: Buffer | undefined;
    }

    let getNextPart = async (query?: FetchQueryObject | undefined): Promise<PartResult> => {
        query = query || {};

        let mimeKey: string | undefined;
        let contentRequest: BodyPartRequest | undefined;

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

            contentRequest = {
                key: part,
                start: processed,
                maxLength: chunkSize
            };
            query.bodyParts.push(contentRequest);
        }

        let expectedUid = uid || requestedUid(range, downloadOptions);
        let expected: ExpectedAnswer = {
            uid: expectedUid,
            origins: new Map([[part || '', processed]]),
            // Every chunk after the first is of a message that was there a moment ago, and a
            // message the caller addresses by UID is taken to exist: an empty answer may be a
            // late one (Apache James), a message that is really gone costs two more requests
            retryEmpty: processed > 0 || expectedUid ? () => !downloadAborted() : undefined
        };
        let response = await fetchExpected(client, range, query, downloadOptions, expected);

        if (!response) {
            return { response: false, chunk: false };
        }

        if (!uid && response.uid) {
            uid = response.uid;
            // force UID from now on even if first range was a sequence number
            range = uid;
            downloadOptions.uid = true;
        }

        if (mimeKey && contentRequest) {
            let dropped = droppedSection(
                mimeKey === 'header' ? response.headers : response.bodyParts?.get(mimeKey),
                response.bodyParts?.get(part!),
                mimeKey,
                contentRequest
            );
            if (dropped) {
                await refetchDroppedSections(client, response, range, downloadOptions, [dropped]);
            }
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

    // Resolves once the head stream can take more input, rejects when it fails, and resolves
    // when it goes away. finish() is the listener itself: 'drain' and 'close' emit no arguments,
    // 'error' emits the error, and removal needs no separate handler references. It removes
    // only the listeners this wait installed - removeAllListeners('error') also took off the
    // forwarder pipeStage() attached to the head stream when the pipeline was built, and the
    // head must keep that forwarder for the life of the download or a chunk failure has nowhere
    // to go.
    let waitForDrain = (): Promise<void> =>
        new Promise<void>((resolve, reject) => {
            const finish = (err?: Error | undefined) => {
                for (let event of DRAIN_WAIT_EVENTS) {
                    stream.removeListener(event, finish);
                }
                /* c8 ignore next 2 */ // stream error during a backpressure drain wait is timing-dependent
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            };
            for (let event of DRAIN_WAIT_EVENTS) {
                stream.once(event, finish);
            }
        });

    // Writes a chunk and waits out the backpressure. A base64 decoder defers its write callback,
    // so a chunk the size of its buffer is never taken synchronously and the head chunk waits
    // here as much as any other. A stream failure during the wait is thrown unless the download
    // was already aborted (the consumer destroyed the stream).
    let writeAndDrain = async (chunk: Buffer): Promise<void> => {
        if (writeChunk(chunk) !== false) {
            return;
        }
        try {
            await waitForDrain();
            /* c8 ignore next 5 */ // re-throw path only triggers on a stream error mid-drain, which is timing-dependent
        } catch (err) {
            if (!fetchAborted) {
                throw err;
            }
        }
    };

    // Writes the head chunk, then fetches the remaining chunks in a loop, writing each to the
    // decoder stream. Stops when the server returns a short chunk (< chunkSize), answers with
    // more than the requested window, the byte limiter is satisfied, or the consumer destroys
    // the output stream. Throws when the ceiling above is crossed.
    let fetchAllParts = async (head: Buffer) => {
        await writeAndDrain(head);
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
            // A consumer that gave up while the chunk was in flight
            if (downloadAborted()) {
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

            await writeAndDrain(chunk);
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

    // Runs the download pipeline with the head chunk fetched above (for its metadata): it is
    // written to the decoder stream and the remaining chunks follow
    let runFetchAllParts = (head: Buffer) => {
        fetchAllParts(head)
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

    // Deferred so the caller gets the {meta, content} return value before streaming begins
    setImmediate(() => runFetchAllParts(chunk));

    return {
        meta,
        content: output
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

    let downloadOptions: DownloadManyOptions = options || {};

    // Asked as a partial fetch so at most maxBytes of each part crosses the wire, and enforced
    // again on the answer for servers that ignore the partial specifier
    let maxBytes = normalizeByteLimit(downloadOptions.maxBytes);

    let query: FetchQueryObject & { bodyParts: NonNullable<FetchQueryObject['bodyParts']> } = { bodyParts: [] };

    let contentRequests = new Map<string, BodyPartRequest>();
    for (let part of parts) {
        query.bodyParts.push(part + '.mime');
        // The partial specifier carries a 32-bit length (RFC 9051 "number"), so a cap beyond
        // that is applied on the answer alone
        let contentRequest: BodyPartRequest = maxBytes > 0xffffffff ? part : { key: part, start: 0, maxLength: maxBytes };
        contentRequests.set(part, contentRequest);
        query.bodyParts.push(contentRequest);
    }

    let expectedUid = requestedUid(range, downloadOptions);
    let response = await fetchExpected(client, range, query, downloadOptions, {
        uid: expectedUid,
        origins: partialStarts(query.bodyParts),
        // a message addressed by UID is taken to exist, as for download()
        retryEmpty: expectedUid ? () => true : undefined
    });

    if (!response || !response.bodyParts) {
        return {};
    }

    let dropped: BodyPartRequest[] = [];
    for (let [part, contentRequest] of contentRequests) {
        let section = droppedSection(response.bodyParts.get(part + '.mime'), response.bodyParts.get(part), part + '.mime', contentRequest);
        if (section) {
            dropped.push(section);
        }
    }
    // Sections of different parts do not collide, so every dropped one fits in one FETCH
    await refetchDroppedSections(client, response, range, downloadOptions, dropped);

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
            let key = keyParts[0];
            if (content.length > maxBytes) {
                // The server ignored the partial specifier and sent the whole part, the quirk
                // download() tolerates the same way: keep what was asked for
                client.log.warn({
                    msg: 'Server returned more than the requested window, truncating the part',
                    part: key,
                    maxBytes,
                    received: content.length,
                    cid: client.id
                });
                content = content.subarray(0, maxBytes);
            }
            if (!data[key]) {
                data[key] = { content };
            } else {
                data[key].content = content;
            }
        } else if (keyParts.length === 2) {
            // header
            let key = keyParts[0];
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
        let entry = data[part];
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
