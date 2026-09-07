import id from './commands/id.js';
import capability from './commands/capability.js';
import namespace from './commands/namespace.js';
import login from './commands/login.js';
import logout from './commands/logout.js';
import starttls from './commands/starttls.js';
import list from './commands/list.js';
import enable from './commands/enable.js';
import select from './commands/select.js';
import fetch from './commands/fetch.js';
import create from './commands/create.js';
import deleteMailbox from './commands/delete.js';
import rename from './commands/rename.js';
import close from './commands/close.js';
import subscribe from './commands/subscribe.js';
import unsubscribe from './commands/unsubscribe.js';
import store from './commands/store.js';
import search from './commands/search.js';
import noop from './commands/noop.js';
import expunge from './commands/expunge.js';
import append from './commands/append.js';
import status from './commands/status.js';
import copy from './commands/copy.js';
import move from './commands/move.js';
import compress from './commands/compress.js';
import quota from './commands/quota.js';
import idle from './commands/idle.js';
import authenticate from './commands/authenticate.js';
import type { ImapFlow } from './imap-flow.js';

/**
 * A command implementation: receives the connection and the arguments passed to
 * `ImapFlow#run()` for that command
 */
export type CommandHandler = (connection: ImapFlow, ...args: any[]) => Promise<any>;

/**
 * IMAP command registry. Maps IMAP command names (uppercase strings) to their
 * corresponding implementation modules from the `commands/` directory.
 *
 * Each entry maps a command name (e.g., "FETCH", "SELECT", "IDLE") to a function
 * that builds the command request and processes the server response. This Map is
 * used by the main ImapFlow client to look up and execute IMAP commands.
 */
const imapCommands: Map<string, CommandHandler> = new Map<string, CommandHandler>([
    ['ID', id],
    ['CAPABILITY', capability],
    ['NAMESPACE', namespace],
    ['LOGIN', login],
    ['LOGOUT', logout],
    ['STARTTLS', starttls],
    ['LIST', list],
    ['ENABLE', enable],
    ['SELECT', select],
    ['FETCH', fetch],
    ['CREATE', create],
    ['DELETE', deleteMailbox],
    ['RENAME', rename],
    ['CLOSE', close],
    ['SUBSCRIBE', subscribe],
    ['UNSUBSCRIBE', unsubscribe],
    ['STORE', store],
    ['SEARCH', search],
    ['NOOP', noop],
    ['EXPUNGE', expunge],
    ['APPEND', append],
    ['STATUS', status],
    ['COPY', copy],
    ['MOVE', move],
    ['COMPRESS', compress],
    ['QUOTA', quota],
    ['IDLE', idle],
    ['AUTHENTICATE', authenticate]
]);

export default imapCommands;
