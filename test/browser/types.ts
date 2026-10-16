// What test/browser/page.ts is asked to run and reports, shared with test/browser/browser-test.ts

import type { ScenarioResult } from '../cloudflare/worker.js';
import type { TourResult } from '../fixtures/api-tour.js';

export interface PageScenario {
    /** `streams`: createStreamsTransport() over web streams, `duplex`: a hand-written ImapTransport */
    transport: 'streams' | 'duplex';
    plugins?: string[] | undefined;
    secure?: boolean | undefined;
    doSTARTTLS?: boolean | undefined;
    /** Run the API tour, otherwise select INBOX and IDLE until the server adds a message */
    tour?: boolean | undefined;
    /** Use the default (pino) logger instead of turning logging off */
    defaultLogger?: boolean | undefined;
}

export type PageResult = TourResult &
    Pick<ScenarioResult, 'ok' | 'error' | 'logs' | 'secureConnection' | 'compressed' | 'capabilities'> & {
        /** How often the streams transport upgraded a connection */
        upgrades: number;
        idle?: { count: number; prevCount: number } | undefined;
    };
