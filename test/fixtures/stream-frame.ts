// Feeds chunks through an ImapStream the way a socket does and collects what it frames. Shared by
// the suites that check framing, so the rules for when a run counts as settled live in one place.

import type { ImapStream } from '../../src/handler/imap-stream.js';
import type { ImapFlowError } from '../../src/errors.js';
import type { ImapStreamItem } from '../../src/handler/types.js';

export interface FramedStream {
    items: ImapStreamItem[];
    error: ImapFlowError | null;
}

/**
 * Writes the chunks one at a time, each after the previous one was consumed, releases every framed
 * response and resolves once the stream ended or failed, one tick later, so anything the stream
 * might still emit after a failure (which it must not) is collected too
 */
export const frameStream = (stream: ImapStream, chunks: Buffer[]): Promise<FramedStream> =>
    new Promise(resolve => {
        const items: ImapStreamItem[] = [];
        let error: ImapFlowError | null = null;
        stream.on('data', (item: ImapStreamItem) => {
            items.push(item);
            item.next();
        });
        stream.on('error', (err: ImapFlowError) => {
            error = err;
        });
        stream.on('close', () => setImmediate(() => resolve({ items, error })));
        stream.on('end', () => setImmediate(() => resolve({ items, error })));
        let i = 0;
        const writeNext = () => {
            if (stream.destroyed) {
                return;
            }
            if (i >= chunks.length) {
                stream.end();
                return;
            }
            stream.write(chunks[i++], writeNext);
        };
        writeNext();
    });
