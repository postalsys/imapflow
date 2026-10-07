// Shared mock connection for the command unit tests. The command implementations under
// src/commands/ take the ImapFlow instance as their first argument; this stands in for it with
// just enough state and methods to run a command without a live server. Any field can be
// replaced through `overrides`.
//
// The mock is typed as the ImapFlow instance it stands in for, so a test reading a member the
// class does not have fails the type-check. The overrides stay untyped on purpose: the tests
// hand in partial stand-ins (an exec() that only returns `next`, a mailbox with a few fields)
// that the real member types would reject.

import imapCommands from '../../src/imap-commands.js';
import type { ImapFlow } from '../../src/imap-flow.js';
import type { MailboxObject, NamespaceObject } from '../../src/types.js';

/**
 * The connection the command tests run against. A mailbox and a namespace are always set on
 * the mock (a test that needs an unselected connection passes `mailbox: false`), so the
 * tests read their fields without narrowing
 */
export type MockConnection = ImapFlow & { mailbox: MailboxObject; namespace: NamespaceObject };

export const createMockConnection = (overrides: Record<string, unknown> = {}): MockConnection => {
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

    const connection = {
        states,
        state: states.SELECTED,
        id: 'test-connection-id',
        // Mirrors imap-flow.js, which always resolves a port before authenticating. Without a
        // default the OAUTHBEARER payload builds `port=undefined`.
        port: 993,
        capabilities: new Map([['IMAP4rev1', true]]),
        enabled: new Set(),
        authCapabilities: new Map(),
        folders: new Map(),
        mailbox: { ...defaultMailbox },
        namespace: { delimiter: '/', prefix: '' },
        expectCapabilityUpdate: false,
        usable: true,
        requestQueue: [],
        log: {
            warn: () => {},
            info: () => {},
            error: () => {},
            debug: () => {},
            trace: () => {}
        },
        close: () => {},
        emit: () => {},
        // No default write(): 'idle rejects wait queue on error' relies on the DONE write failing.
        // Tests that need it pass one in.
        // A live transport: command implementations that guard against polling or writing on a
        // dead connection (idle.js) need this to look established.
        socket: { destroyed: false },
        currentSelectCommand: false,
        skipListSubscribedArg: false,
        skipListStatusArgs: false,
        skipListAuxArgs: false,
        skipLsub: false,
        skipRev2: false,
        messageFlagsAdd: async () => true,
        messageCopy: async () => {},
        messageDelete: async () => {},
        // Mirrors ImapFlow.throttleWait(): resolves false on normal expiry, true when close()
        // aborted the wait. The mock resolves immediately so throttle retries stay fast.
        throttleWait: async () => false,
        createNoConnectionError: () => Object.assign(new Error('Connection not available'), { code: 'NoConnection' }),
        run: async () => {},
        // Mirrors ImapFlow.runInternal(): dispatch through the command registry without the
        // preCheck/auto-IDLE handshake that run() performs, so a fallback poll runs the real
        // SELECT/STATUS implementation.
        runInternal: async (command: string, ...args: unknown[]) => {
            let handler = imapCommands.get(command.toUpperCase());
            return handler ? await handler(connection, ...args) : false;
        },
        exec: async () => ({
            next: () => {},
            response: { attributes: [] }
        }),
        // every default above is replaced by an override of the same name
        ...overrides
    } as unknown as MockConnection;

    return connection;
};
