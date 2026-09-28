import pino, { type Logger as PinoLogger } from 'pino';

let logger: PinoLogger | null = null;

/**
 * Returns the shared default logger, used when a connection is given no logger of its own.
 * Created on first use, so importing the library does not set up a stdout logger nobody asked
 * for. Level info: a caller that asks for raw socket data (logRaw) lowers its own child logger
 * to trace.
 *
 * @returns The default pino logger
 */
export function getDefaultLogger(): PinoLogger {
    if (!logger) {
        logger = pino({ level: 'info' });
    }
    return logger;
}

/**
 * Returns the child of the default logger a connection logs through when it was given no
 * logger of its own.
 *
 * @param options - cid is the connection id to stamp on entries, logRaw asks for raw socket data
 * @returns A child logger of the default logger
 */
export function createConnectionLogger(options: { cid?: string | undefined; logRaw?: boolean | undefined }): PinoLogger {
    let child = getDefaultLogger().child({
        component: 'imap-connection',
        cid: options.cid
    });
    // Raw socket data is logged at trace level, so asking for it lowers the threshold
    if (options.logRaw) {
        child.level = 'trace';
    }
    return child;
}
