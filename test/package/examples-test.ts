import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// The examples are plain JavaScript that ESLint and the type-check skip, so nothing noticed when
// they drifted from the API. They import 'imapflow' by name, which resolves to the built package
// through its own exports map, so type-checking them (checkJs) tests them against the shipped
// declarations the way a user's editor sees them.
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tsc = require.resolve('typescript/bin/tsc');

const hasDist = fs.existsSync(path.join(root, 'dist', 'esm', 'imap-flow.d.ts'));

describe('Examples', () => {
    it('type-check against the built declarations', { skip: !hasDist && 'dist/ is not built' }, () => {
        const result = spawnSync(process.execPath, [tsc, '-p', path.join(root, 'tsconfig.examples.json')], { cwd: root, encoding: 'utf8' });
        assert.equal(result.status, 0, 'tsc reported\n' + result.stdout + result.stderr);
    });
});
