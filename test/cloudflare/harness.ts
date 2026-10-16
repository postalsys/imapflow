// Helpers the Workers and celld harnesses share: a free port for the runtime to listen on, a
// throwaway Ethereal account for the TLS cases, and a check that a public server answers.

import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { ScenarioResult } from './worker.js';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const freePort = (): Promise<number> =>
    new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const port = (probe.address() as net.AddressInfo).port;
            probe.close(() => resolve(port));
        });
    });

export interface EtherealAccount {
    user: string;
    pass: string;
    imap: { host: string; port: number; secure: boolean };
}

// A throwaway account on Ethereal (https://ethereal.email), the test mail service run by the
// Nodemailer project: everything sent to it lands in its own inbox and nothing leaves
export const createEtherealAccount = async (): Promise<EtherealAccount | null> => {
    try {
        const response = await fetch('https://api.nodemailer.com/user', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ requestor: 'imapflow', version: require(path.join(root, 'package.json')).version }),
            signal: AbortSignal.timeout(20 * 1000)
        });
        const account = (await response.json()) as EtherealAccount & { status?: string };
        return account && account.status === 'success' && account.imap ? account : null;
    } catch {
        return null;
    }
};

// Whether a host answers on a port from here, for the cases that need a public server
export const reachable = (host: string, port: number): Promise<boolean> =>
    new Promise(resolve => {
        const socket = net.connect({ host, port });
        socket.setTimeout(10 * 1000);
        socket.once('connect', () => {
            socket.destroy();
            resolve(true);
        });
        socket.once('timeout', () => {
            socket.destroy();
            resolve(false);
        });
        socket.once('error', () => resolve(false));
    });

// The error and the log of a scenario, as an assertion message
export const details = (result: ScenarioResult): string => JSON.stringify(result.error) + '\n' + result.logs.join('\n');
