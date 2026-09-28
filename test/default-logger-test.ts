import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ImapFlow } from '../src/imap-flow.js';
import { ImapStream } from '../src/handler/imap-stream.js';
import { createConnectionLogger } from '../src/logger.js';

// The default pino logger used to be created, at level trace, the moment the library was
// imported. It is now created on first use by a connection that was given no logger, at level
// info unless logRaw asks for the raw socket data. Checked in a child process against the
// CommonJS build, where a require hook can count pino() calls without touching this process.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'dist', 'cjs', 'imap-flow.js');
const streamEntry = path.join(root, 'dist', 'cjs', 'handler', 'imap-stream.js');

const script = `
const Module = require('node:module');
const originalLoad = Module._load;
let created = 0;
Module._load = function (request) {
    const loaded = originalLoad.apply(this, arguments);
    if (request !== 'pino') {
        return loaded;
    }
    const counted = function () {
        created++;
        return loaded.apply(this, arguments);
    };
    return Object.assign(counted, loaded);
};

const { ImapFlow } = require(${JSON.stringify(entry)});
const { ImapStream } = require(${JSON.stringify(streamEntry)});
const report = { afterImport: created };

new ImapFlow({ host: '127.0.0.1', logger: false }).log.error({ msg: 'disabled' });
report.afterLoggerFalse = created;

const supplied = [];
const custom = { trace() {}, debug() {}, info: entry => supplied.push(entry), warn() {}, error() {} };
new ImapFlow({ host: '127.0.0.1', logger: custom }).log.info({ msg: 'to supplied' });
report.afterSupplied = created;
report.supplied = supplied.map(entry => entry.msg);

const plain = new ImapFlow({ host: '127.0.0.1' });
plain.log.debug({ msg: 'default-debug' });
plain.log.info({ msg: 'default-info' });
const raw = new ImapFlow({ host: '127.0.0.1', logRaw: true });
raw.log.trace({ msg: 'raw-trace' });
new ImapStream({}).log.trace({ msg: 'stream-trace' });
new ImapStream({ logRaw: true }).log.trace({ msg: 'stream-raw-trace' });
report.afterDefault = created;

process.stderr.write(JSON.stringify(report));
`;

describe('default logger', { skip: process.versions.bun ? 'uses a Node-only require hook' : false }, () => {
    it('is created on first use, at level info unless logRaw is set', () => {
        // npm test builds dist/ first (pretest), so a missing build is a setup error, not a skip
        assert.ok(fs.existsSync(entry), `${entry} is missing, run "npm run build" before this test`);
        const result = spawnSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);

        const report = JSON.parse(result.stderr);
        assert.equal(report.afterImport, 0, 'importing the library does not create a logger');
        assert.equal(report.afterLoggerFalse, 0, 'logger: false does not create one either');
        assert.equal(report.afterSupplied, 0, 'a supplied logger is used exclusively');
        assert.deepEqual(report.supplied, ['to supplied']);
        assert.equal(report.afterDefault, 1, 'connections and streams share one default logger');

        const lines = result.stdout
            .split('\n')
            .filter(line => line)
            .map(line => JSON.parse(line).msg);
        assert.deepEqual(lines, ['default-info', 'raw-trace', 'stream-raw-trace']);
    });

    it('uses a supplied logger instead of the default one, with or without logRaw', () => {
        // In-process counterpart of the check above, so the source is covered as well
        for (const logRaw of [false, true]) {
            const entries: any[] = [];
            const logger = { debug() {}, info: (entry: any) => entries.push(entry), warn() {}, error() {} };
            new ImapFlow({ host: '127.0.0.1', logger, logRaw }).log.info({ msg: 'supplied' });
            assert.deepEqual(
                entries.map(entry => entry.msg),
                ['supplied']
            );

            // Without one, the default logger is taken; logRaw only changes its level
            let level = logRaw ? 'trace' : 'info';
            assert.equal(createConnectionLogger({ cid: 'c1', logRaw }).level, level);
            assert.equal((new ImapStream({ logRaw }).log as any).level, level);
        }
    });
});
