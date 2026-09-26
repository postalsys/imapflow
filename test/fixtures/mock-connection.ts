// Shared mock connection for the command unit tests. The command implementations under
// src/commands/ take the ImapFlow instance as their first argument; this stands in for it with
// just enough state and methods to run a command without a live server. Any field can be
// replaced through `overrides`.

import imapCommands from '../../src/imap-commands.js';

export const createMockConnection = (overrides = {}) => {
    const states = {
        NOT_AUTHENTICATED: 1,
        AUTHENTICATED: 2,
        SELECTED: 3,
        LOGOUT: 4
    };

    const defaultMailbox = {
        path: 'INBOX',
        flags: new Set(['\\Seen', '\\Answered', '\\Flagged', '\\Deleted', '\\Draft']),
        permanentFlags: new Set(['\\*']),
        exists: 100,
        recent: 5,
        uidNext: 1000,
        uidValidity: BigInt(12345),
        noModseq: false
    };

    const connection: any = {
        states,
        state: (overrides as any).state || states.SELECTED,
        id: 'test-connection-id',
        // Mirrors imap-flow.js, which always resolves a port before authenticating. Without a
        // default the OAUTHBEARER payload builds `port=undefined`.
        port: (overrides as any).port || 993,
        capabilities: new Map((overrides as any).capabilities || [['IMAP4rev1', true]]),
        enabled: new Set((overrides as any).enabled || []),
        authCapabilities: new Map(),
        folders: (overrides as any).folders || new Map(),
        mailbox: (overrides as any).mailbox || { ...defaultMailbox },
        namespace: (overrides as any).namespace || { delimiter: '/', prefix: '' },
        expectCapabilityUpdate: (overrides as any).expectCapabilityUpdate || false,
        log: {
            warn: () => {},
            info: () => {},
            error: () => {},
            debug: () => {},
            trace: () => {}
        },
        close: (overrides as any).close || (() => {}),
        emit: (overrides as any).emit || (() => {}),
        // No default write(): 'idle rejects wait queue on error' relies on the DONE write failing.
        // Tests that need it pass one in.
        // A live transport: command implementations that guard against polling or writing on a
        // dead connection (idle.js) need this to look established.
        socket: (overrides as any).socket || { destroyed: false },
        currentSelectCommand: false,
        skipListSubscribedArg: false,
        skipListStatusArgs: false,
        skipListAuxArgs: false,
        skipLsub: false,
        skipRev2: false,
        messageFlagsAdd: (overrides as any).messageFlagsAdd || (async () => {}),
        messageCopy: (overrides as any).messageCopy || (async () => {}),
        messageDelete: (overrides as any).messageDelete || (async () => {}),
        // Mirrors ImapFlow.throttleWait(): resolves false on normal expiry, true when close()
        // aborted the wait. The mock resolves immediately so throttle retries stay fast.
        throttleWait: (overrides as any).throttleWait || (async () => false),
        createNoConnectionError:
            (overrides as any).createNoConnectionError || (() => Object.assign(new Error('Connection not available'), { code: 'NoConnection' })),
        run: (overrides as any).run || (async () => {}),
        // Mirrors ImapFlow.runInternal(): dispatch through the command registry without the
        // preCheck/auto-IDLE handshake that run() performs, so a fallback poll runs the real
        // SELECT/STATUS implementation.
        runInternal:
            (overrides as any).runInternal ||
            (async (command: any, ...args: any[]) => {
                let handler = imapCommands.get(command.toUpperCase());
                return handler ? await handler(connection, ...args) : false;
            }),
        exec:
            (overrides as any).exec ||
            (async () => ({
                next: () => {},
                response: { attributes: [] }
            })),
        ...overrides
    };

    return connection;
};
