// A scriptable in-process IMAP server for end-to-end ImapFlow tests. It answers a full happy-path
// session by default (greeting, CAPABILITY, ID, NAMESPACE, ENABLE, LOGIN, SELECT, LIST, STATUS,
// SEARCH, NOOP, LOGOUT, ...), and a test overrides single commands through `handlers` to script
// the server behavior it needs. Shared by the suites that drive a real client over a socket
// instead of each carrying its own copy.

import net from 'node:net';
import { ImapFlow } from '../../src/imap-flow.js';

export interface ScriptedServerOptions {
    /** Capability list advertised in the greeting and in CAPABILITY responses */
    capabilities?: string | undefined;
    /** Replaces the default greeting line (CRLF included) */
    greeting?: string | undefined;
    /** Per-command overrides, see createServer() */
    handlers?: Record<string, ((ctx: any) => void) | null> | undefined;
    /** Called with every accepted socket before the greeting is written */
    onConnect?: ((socket: net.Socket) => void) | undefined;
}

/**
 * Splits what a client writes into command lines the way a server reads them: a line ending in a
 * "{n}" literal marker is joined with what follows the literal data, with "<literal> " in place of
 * the marker and the data, and a synchronizing "{n}" (not "{n+}") gets its continuation request
 */
export const readCommandLines = (socket: net.Socket, onLine: (line: string) => void): void => {
    let buf = Buffer.alloc(0);
    let literalRemaining = 0;
    let cmdPrefix = '';

    const processBuffer = () => {
        // Loop until we run out of complete lines / literal data.
        while (true) {
            if (literalRemaining > 0) {
                if (buf.length < literalRemaining) {
                    return;
                }
                buf = buf.subarray(literalRemaining);
                literalRemaining = 0;
                // Fall through to read the continuation line (post-literal text + CRLF)
            }

            let idx = buf.indexOf('\r\n');
            if (idx < 0) {
                return;
            }
            let line = buf.subarray(0, idx).toString('binary');
            buf = buf.subarray(idx + 2);

            let combined = cmdPrefix + line;

            // Synchronizing / non-synchronizing literal at end of line?
            let m = combined.match(/\{(\d+)(\+)?\}$/);
            if (m) {
                literalRemaining = Number(m[1]);
                // Keep the prefix (sans literal marker) for command keyword extraction
                cmdPrefix = combined.slice(0, -m[0].length) + '<literal> ';
                if (!m[2]) {
                    // synchronizing literal -> tell client to proceed
                    socket.write('+ Ready for literal data\r\n');
                }
                continue;
            }

            cmdPrefix = '';
            onLine(combined);
        }
    };

    socket.on('data', chunk => {
        buf = Buffer.concat([buf, chunk]);
        processBuffer();
    });
};

// ---------------------------------------------------------------------------
// Mock IMAP server
// ---------------------------------------------------------------------------
// `handlers` maps an uppercase command keyword to (ctx) => void, where ctx
// provides { tag, line, args, write(str), ok(text), no(text), bad(text), socket }.
// Sensible defaults are provided for a full happy-path session; tests override
// individual commands as needed.
export const createServer = (options: ScriptedServerOptions = {}) => {
    const capabilities = options.capabilities || 'IMAP4rev1 ID ENABLE NAMESPACE UIDPLUS CONDSTORE MOVE QUOTA';
    const greeting = options.greeting || `* OK [CAPABILITY ${capabilities}] mock ready\r\n`;

    const defaults = {
        CAPABILITY(ctx: any) {
            ctx.write(`* CAPABILITY ${capabilities}\r\n`);
            ctx.ok('CAPABILITY completed');
        },
        ID(ctx: any) {
            ctx.write('* ID ("name" "mock" "version" "1.0")\r\n');
            ctx.ok('ID completed');
        },
        NAMESPACE(ctx: any) {
            ctx.write('* NAMESPACE (("" "/")) NIL NIL\r\n');
            ctx.ok('NAMESPACE completed');
        },
        ENABLE(ctx: any) {
            ctx.write('* ENABLED CONDSTORE\r\n');
            ctx.ok('ENABLE completed');
        },
        LOGIN(ctx: any) {
            ctx.ok('LOGIN completed');
        },
        COMPRESS(ctx: any) {
            ctx.no('COMPRESS not available');
        },
        SELECT(ctx: any) {
            ctx.write('* 3 EXISTS\r\n');
            ctx.write('* 0 RECENT\r\n');
            ctx.write('* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)\r\n');
            ctx.write('* OK [PERMANENTFLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft \\*)] Limited\r\n');
            ctx.write('* OK [UIDVALIDITY 12345] UIDs valid\r\n');
            ctx.write('* OK [UIDNEXT 100] Predicted next UID\r\n');
            ctx.write('* OK [HIGHESTMODSEQ 1000] Highest\r\n');
            ctx.ok('[READ-WRITE] SELECT completed');
        },
        EXAMINE(ctx: any) {
            ctx.write('* 3 EXISTS\r\n');
            ctx.write('* OK [UIDVALIDITY 12345] UIDs valid\r\n');
            ctx.write('* OK [UIDNEXT 100] Predicted next UID\r\n');
            ctx.ok('[READ-ONLY] EXAMINE completed');
        },
        LIST(ctx: any) {
            ctx.write('* LIST (\\HasNoChildren) "/" "INBOX"\r\n');
            ctx.write('* LIST (\\HasNoChildren \\Sent) "/" "Sent"\r\n');
            ctx.ok('LIST completed');
        },
        LSUB(ctx: any) {
            ctx.write('* LSUB (\\HasNoChildren) "/" "INBOX"\r\n');
            ctx.ok('LSUB completed');
        },
        STATUS(ctx: any) {
            ctx.write('* STATUS "INBOX" (MESSAGES 3 UIDNEXT 100 UIDVALIDITY 12345 UNSEEN 1)\r\n');
            ctx.ok('STATUS completed');
        },
        NOOP(ctx: any) {
            ctx.ok('NOOP completed');
        },
        LOGOUT(ctx: any) {
            ctx.write('* BYE Logging out\r\n');
            ctx.ok('LOGOUT completed');
        },
        SEARCH(ctx: any) {
            ctx.write('* SEARCH 1 2 3\r\n');
            ctx.ok('SEARCH completed');
        },
        CREATE(ctx: any) {
            ctx.ok('CREATE completed');
        },
        DELETE(ctx: any) {
            ctx.ok('DELETE completed');
        },
        RENAME(ctx: any) {
            ctx.ok('RENAME completed');
        },
        SUBSCRIBE(ctx: any) {
            ctx.ok('SUBSCRIBE completed');
        },
        UNSUBSCRIBE(ctx: any) {
            ctx.ok('UNSUBSCRIBE completed');
        }
    };

    const handlers = Object.assign({}, defaults, options.handlers || {});

    const server = net.createServer(socket => {
        socket.setNoDelay(true);
        socket.on('error', () => {});
        if (options.onConnect) {
            options.onConnect(socket);
        }
        if (greeting) {
            socket.write(greeting);
        }

        const dispatch = (fullLine: any) => {
            // fullLine is the first physical line of the command (tag + command + args);
            // literal payloads are not needed to choose a response.
            let parts = fullLine.split(' ');
            let tag = parts[0];
            let command = (parts[1] || '').toUpperCase();
            // IDLE is terminated by a bare, untagged "DONE" continuation line, so it
            // has no tag/command split, so route it to the DONE handler explicitly.
            if (!parts[1] && (parts[0] || '').toUpperCase() === 'DONE') {
                command = 'DONE';
            }
            let args = parts.slice(2).join(' ');

            const ctx = {
                tag,
                command,
                line: fullLine,
                args,
                socket,
                write: (str: any) => socket.write(str),
                ok: (text: any) => socket.write(`${tag} OK ${text || 'completed'}\r\n`),
                no: (text: any) => socket.write(`${tag} NO ${text || 'failed'}\r\n`),
                bad: (text: any) => socket.write(`${tag} BAD ${text || 'bad'}\r\n`)
            };

            let handler = handlers[command];
            if (typeof handler === 'function') {
                handler(ctx);
            } else if (handler === null) {
                // explicitly silent (e.g. simulate no response)
            } else {
                ctx.bad(`Unknown command ${command}`);
            }
        };

        readCommandLines(socket, dispatch);
    });

    return server;
};

export const listen = (server: any): Promise<number> => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

export const makeClient = (port: any, overrides = {}): ImapFlow =>
    new ImapFlow({
        host: '127.0.0.1',
        port,
        secure: false,
        disableAutoIdle: true,
        disableCompression: true,
        logger: false,
        auth: { user: 'test', pass: 'secret' },
        ...overrides
    });
