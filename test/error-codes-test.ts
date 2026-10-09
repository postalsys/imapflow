import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ImapFlowErrorCode } from '../src/imap-flow.js';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));

// Every source file except errors.ts, which declares the codes
const sources = fs
    .readdirSync(srcDir, { recursive: true, encoding: 'utf-8' })
    .filter(name => name.endsWith('.ts') && name !== 'errors.ts')
    .map(name => fs.readFileSync(path.join(srcDir, name), 'utf-8'));

describe('ImapFlowErrorCode', () => {
    // createImapError() and the helpers built on it type their code as ImapFlowErrorCode, so the
    // compiler checks those. What is left are the few errors that get their code assigned
    // directly: `.code = 'X'` or `.code = (...) || 'X'`.
    it('lists every error code the library assigns directly', () => {
        const listed = new Set<string>(Object.values(ImapFlowErrorCode));
        const assigned = sources.flatMap(source => [...source.matchAll(/\.code = (?:[^;]*\|\| )?'([A-Za-z0-9_]+)'/g)].map(match => match[1]!));
        assert.ok(assigned.length > 0, 'the scan found the directly assigned codes');
        for (const code of assigned) {
            assert.ok(listed.has(code), `${code} is set in src/ but missing from ImapFlowErrorCode`);
        }
    });

    it('lists no code the library does not use', () => {
        for (const code of Object.values(ImapFlowErrorCode)) {
            assert.ok(
                sources.some(source => source.includes(`'${code}'`)),
                `${code} is listed but not used anywhere in src/`
            );
        }
    });

    it('maps every key to its own name', () => {
        for (const [key, value] of Object.entries(ImapFlowErrorCode)) {
            assert.equal(value, key);
        }
    });
});
