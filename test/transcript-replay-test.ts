import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ImapStream } from '../src/handler/imap-stream.js';
import { parser } from '../src/handler/imap-handler.js';
import { parseTranscript, startTranscriptServer, withTag } from './fixtures/transcript-server.js';
import { installRejectionDetector } from './fixtures/test-client.js';
import { makeClient } from './fixtures/scripted-server.js';
import { frameStream } from './fixtures/stream-frame.js';
import { transcripts } from './fixtures/transcripts.js';

// Replays server sessions with known quirks against a real client (see fixtures/transcripts.ts),
// and checks that every server line of every transcript parses.
//
// Real sessions that can not be committed (captured from production, with credentials and mail
// content) are checked the same way for a local run: every *.txt file below the directories in
// IMAPFLOW_TRANSCRIPT_DIR (colon separated) is read as a transcript and each of its server lines
// must parse.

// Frames the server side of a transcript the way the client reads it and parses every response
const parseServerLines = async (text: string): Promise<number> => {
    const transcript = parseTranscript(text);
    const bursts = [transcript.greeting, ...transcript.steps.map(step => step.server)].filter(lines => lines.length);
    let count = 0;
    for (const lines of bursts) {
        const { items, error } = await frameStream(new ImapStream({ cid: 'transcript', logger: false } as any), [
            Buffer.from(lines.map(line => withTag(line, 'A1') + '\r\n').join(''), 'binary')
        ]);
        assert.equal(error, null, `framing failed for ${JSON.stringify(lines)}`);
        for (const item of items) {
            await assert.doesNotReject(
                parser(item.payload, { literals: item.literals }),
                `unparseable server line ${JSON.stringify(item.payload.toString('latin1'))}`
            );
            count++;
        }
    }
    return count;
};

const externalTranscripts = (): string[] =>
    (process.env.IMAPFLOW_TRANSCRIPT_DIR || '')
        .split(':')
        .filter(Boolean)
        .flatMap(dir =>
            fs
                .readdirSync(dir, { recursive: true, encoding: 'utf-8' })
                .filter(name => name.endsWith('.txt'))
                .map(name => path.join(dir, name))
        );

describe('transcript replay', () => {
    for (const quirk of transcripts) {
        it(`${quirk.name} (${quirk.origin})`, async () => {
            const server = await startTranscriptServer(quirk.transcript);
            const detector = installRejectionDetector();
            const client = makeClient(server.port, { auth: { user: 'user', pass: 'pass' }, ...quirk.options });
            client.on('error', () => {});
            try {
                await client.connect();
                await quirk.run(client);
                await client.logout();
            } catch (err) {
                // the commands the transcript did not expect usually explain the failure
                (err as Error).message += `\nunexpected commands: ${JSON.stringify(server.mismatches)}`;
                throw err;
            } finally {
                client.close();
                await server.close();
                detector.check();
            }
            assert.deepEqual(server.mismatches, [], 'the client sent commands the transcript does not have');
            assert.deepEqual(
                server.remaining().map(step => step.client),
                [],
                'the client did not send every command of the transcript'
            );
        });
    }

    it('every server line of the transcripts parses', async () => {
        for (const quirk of transcripts) {
            assert.ok((await parseServerLines(quirk.transcript)) > 0, quirk.name);
        }
    });

    const external = externalTranscripts();
    it(`every server line of ${external.length} external transcripts parses`, { skip: !external.length && 'IMAPFLOW_TRANSCRIPT_DIR not set' }, async () => {
        for (const file of external) {
            await parseServerLines(fs.readFileSync(file, 'binary')).catch(err => {
                throw new Error(`${file}: ${err.message}`);
            });
        }
    });
});
