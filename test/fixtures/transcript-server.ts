// Replays a recorded IMAP session against a real client. A transcript is plain text:
//
//   # a comment
//   S: * OK [CAPABILITY IMAP4rev1] ready      a line the server sends (CRLF is added)
//   C: LOGIN                                  the command the client must send next
//   S: TAG OK LOGIN completed                 TAG is replaced with the tag of that command
//
// Server lines before the first C: line are the greeting. A C: line is matched against the
// client's command with the tag removed, as a case-insensitive prefix. Every following S: line,
// up to the next C: line, is the answer. Literal data in an answer is written as the lines it
// spans, so a "{n}" counts the CRLF between them.
//
// A command that does not match the next C: line, or that comes after the transcript ran out,
// is answered with BAD and recorded in `mismatches`, so a test fails on any command the
// recorded server never saw. LOGOUT after the end of the transcript is answered normally.

import net from 'node:net';
import { listen, readCommandLines } from './scripted-server.js';

export interface TranscriptStep {
    client: string;
    server: string[];
}

export interface Transcript {
    greeting: string[];
    steps: TranscriptStep[];
}

export interface TranscriptServer {
    port: number;
    /** Commands that did not match the transcript, as "expected ... got ..." */
    mismatches: string[];
    /** Steps of the transcript the client has not reached */
    remaining(): TranscriptStep[];
    close(): Promise<void>;
}

/**
 * Puts the command tag in place of the TAG placeholder, behind any NUL padding the line starts with
 */
export const withTag = (line: string, tag: string): string => line.replace(/^(\0*)TAG(?= )/, (match, padding) => padding + tag);

export const parseTranscript = (text: string): Transcript => {
    const transcript: Transcript = { greeting: [], steps: [] };
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.replace(/^\s+/, '');
        if (!line || line.startsWith('#')) {
            continue;
        }
        const match = line.match(/^([SC]): ?(.*)$/s);
        if (!match) {
            throw new Error(`Transcript line is neither S: nor C: ${JSON.stringify(rawLine)}`);
        }
        if (match[1] === 'C') {
            transcript.steps.push({ client: match[2]!, server: [] });
        } else if (transcript.steps.length) {
            transcript.steps.at(-1)!.server.push(match[2]!);
        } else {
            transcript.greeting.push(match[2]!);
        }
    }
    return transcript;
};

export const startTranscriptServer = async (text: string): Promise<TranscriptServer> => {
    const transcript = parseTranscript(text);
    const steps = transcript.steps.slice();
    const mismatches: string[] = [];
    const sockets = new Set<net.Socket>();

    const server = net.createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.setNoDelay(true);
        socket.on('error', () => {});

        const send = (lines: string[], tag: string) => {
            if (lines.length) {
                socket.write(Buffer.from(lines.map(line => withTag(line, tag) + '\r\n').join(''), 'binary'));
            }
        };

        const dispatch = (line: string) => {
            // IDLE ends with an untagged DONE, every other command line starts with a tag
            const untagged = /^DONE$/i.test(line);
            const space = line.indexOf(' ');
            const tag = untagged || space < 0 ? '' : line.slice(0, space);
            const command = untagged || space < 0 ? line : line.slice(space + 1);
            const step = steps[0];

            if (step && command.toUpperCase().startsWith(step.client.toUpperCase())) {
                steps.shift();
                return send(step.server, tag);
            }
            if (!step && /^LOGOUT$/i.test(command)) {
                return send(['* BYE Logging out', `${tag} OK LOGOUT completed`], tag);
            }
            mismatches.push(`expected ${step ? JSON.stringify(step.client) : 'nothing'}, got ${JSON.stringify(command)}`);
            if (!untagged) {
                send([`${tag} BAD Unexpected command`], tag);
            }
        };

        readCommandLines(socket, dispatch);

        send(transcript.greeting, '*');
    });

    const port = await listen(server);
    return {
        port,
        mismatches,
        remaining: () => steps.slice(),
        // closes the connections too, so a client stuck on a missing answer can not keep the
        // server open
        close: () =>
            new Promise(done => {
                server.close(() => done());
                for (const socket of sockets) {
                    socket.destroy();
                }
            })
    };
};
