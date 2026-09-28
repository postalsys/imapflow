import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ImapFlowErrorCode } from '../src/imap-flow.js';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));

// Every literal error code the sources set: `.code = 'X'`, `.code = (...) || 'X'`,
// createConnectionError('X', ...), fail('X', ...) in search-compiler.ts and proxyError(..., 'X')
// or proxyError(..., ... || 'X').
const collectCodes = (): Set<string> => {
    const patterns = [
        /\.code = (?:[^;]*\|\| )?'([A-Za-z0-9_]+)'/g,
        /createConnectionError\('([A-Za-z0-9_]+)'/g,
        /\bfail\('([A-Za-z0-9_]+)'/g,
        /proxyError\([^;]*?(?:, |\|\| )'([A-Za-z0-9_]+)'\)/g
    ];
    const codes = new Set<string>();
    for (const file of fs.readdirSync(srcDir, { recursive: true, encoding: 'utf-8' }).filter(name => name.endsWith('.ts'))) {
        const source = fs.readFileSync(path.join(srcDir, file), 'utf-8');
        for (const pattern of patterns) {
            for (const match of source.matchAll(pattern)) {
                codes.add(match[1]!);
            }
        }
    }
    return codes;
};

const found = collectCodes();

describe('ImapFlowErrorCode', () => {
    it('lists every error code the library sets', () => {
        const listed = new Set<string>(Object.values(ImapFlowErrorCode));
        const set = [...found].filter(code => !/^ParserError\d+$/.test(code));
        assert.ok(set.length > 20, 'the scan found the error codes');
        for (const code of set) {
            assert.ok(listed.has(code), `${code} is set in src/ but missing from ImapFlowErrorCode`);
        }
    });

    it('lists no code the library does not set', () => {
        for (const code of Object.values(ImapFlowErrorCode)) {
            // set through a template literal
            if (code.startsWith('ClosedAfterConnect')) {
                continue;
            }
            assert.ok(found.has(code), `${code} is listed but not set anywhere in src/`);
        }
    });

    it('maps every key to its own name', () => {
        for (const [key, value] of Object.entries(ImapFlowErrorCode)) {
            assert.equal(value, key);
        }
    });

    it('covers both ClosedAfterConnect variants', () => {
        const source = fs.readFileSync(path.join(srcDir, 'imap-flow.ts'), 'utf-8');
        assert.ok(source.includes("`ClosedAfterConnect${this.secureConnection ? 'TLS' : 'Text'}`"));
    });
});
