/* eslint no-console: 0 */

// Mutation testing for the protocol code: the response parser, the stream framing, the command
// compiler and the search compiler.
//
// Each mutant is one source file with one small change (a flipped comparison, an off by
// one constant, a swapped boolean operator, a changed line break, a dropped negation). The mutant
// is written into a private copy of the repository and the matching suites run against it. A
// mutant that no test catches ("survives") marks behavior the suites do not pin: either a missing
// assertion, or an equivalent mutant that can not change any output (an extra empty iteration, a
// return value nobody reads), which has to be checked by hand.
//
// Usage: npm run test:mutation -- [--workers 6] [--max 400] [--file src/handler/token-parser.ts]
//        [--survivors <json>]  re-run only the mutants listed in a survivors file of an earlier run
// Survivors are written to imapflow-mutation-survivors.json in the system temp directory. The
// repository itself is never modified.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => {
    let i = args.indexOf('--' + name);
    return i >= 0 ? args[i + 1] : def;
};

const FILES = opt('file', '')
    ? [opt('file')]
    : [
          'src/handler/token-parser.ts',
          'src/handler/parser-instance.ts',
          'src/handler/imap-parser.ts',
          'src/handler/imap-stream.ts',
          'src/handler/imap-compiler.ts',
          'src/handler/limits.ts',
          'src/search-compiler.ts'
      ];
const WORKERS = Number(opt('workers', Math.max(2, os.cpus().length - 2)));
const MAX = Number(opt('max', 0));

// The suites that cover each source file; a mutant runs only the ones for its file
const HANDLER_TESTS = [
    'test/token-parser-test.ts',
    'test/imap-parser-test.ts',
    'test/imap-compiler-test.ts',
    'test/imap-formal-syntax-test.ts',
    'test/imap-stream-test.ts',
    'test/imap-stream-edge-cases-test.ts',
    'test/parser-limits-test.ts',
    'test/handler-branches-test.ts',
    'test/parser-fuzz-test.ts',
    'test/transcript-replay-test.ts',
    'test/commands/security-regression-test.ts'
];
const SEARCH_TESTS = ['test/search-compiler-test.ts', 'test/search-test.ts', 'test/commands/search-test.ts', 'test/commands/security-regression-test.ts'];
const testsFor = file => (file === 'src/search-compiler.ts' ? SEARCH_TESTS : HANDLER_TESTS);
const ALL_TESTS = [...new Set([...HANDLER_TESTS, ...SEARCH_TESTS])];

// operator replacements, applied to code (comments are skipped)
const OPERATORS = [
    [/[=]==/g, '!=='],
    [/!==/g, '==='],
    [/ <= /g, ' < '],
    [/ < /g, ' <= '],
    [/ >= /g, ' > '],
    [/ > /g, ' >= '],
    [/ && /g, ' || '],
    [/ \|\| /g, ' && '],
    [/ \+ 1\b/g, ' + 2'],
    [/ - 1\b/g, ' - 2'],
    [/ \+ 2\b/g, ' + 1'],
    [/\btrue\b/g, 'false'],
    [/\bfalse\b/g, 'true'],
    [/\\r\\n/g, '\\n'],
    [/\(!(?!=)/g, '(']
];

// Lines that carry no runtime behavior: comments, imports, type declarations, and class fields or
// interface members declared with a type only ("name?: string | undefined;")
const SKIP_LINE = /^\s*(\*|\/\*|\/\/|import\b|export\s+(type|interface)\b|type\b|interface\b|declare\b|(readonly\s+)?[\w$]+\??:\s[^=]*;\s*$)/;

// A match in a type position: a return type ("): false {") or a member of a type union
// ("string | false"). Object literal values ("raw: true") and ternary branches stay mutated
const IN_TYPE = /(\):\s*|[^|]\|\s*)$/;

function mutantsOf(file) {
    let source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    let lines = source.split('\n');
    let mutants = [];
    let inBlockComment = false;
    lines.forEach((line, index) => {
        // lines inside a /* ... */ block are comments too, whatever they start with
        if (inBlockComment) {
            inBlockComment = !line.includes('*/');
            return;
        }
        if (/^\s*\/\*/.test(line) && !line.includes('*/')) {
            inBlockComment = true;
            return;
        }
        let code = line.replace(/\/\/.*$/, '');
        if (SKIP_LINE.test(line) || !code.trim()) {
            return;
        }
        for (let [pattern, replacement] of OPERATORS) {
            pattern.lastIndex = 0;
            let match;
            while ((match = pattern.exec(code))) {
                if (/^(true|false)$/.test(match[0]) && IN_TYPE.test(code.slice(0, match.index))) {
                    continue;
                }
                let mutatedLine = line.slice(0, match.index) + replacement + line.slice(match.index + match[0].length);
                if (mutatedLine !== line) {
                    // only the changed line is kept, the source is rebuilt when the mutant runs
                    mutants.push({ file, line: index + 1, from: line.trim(), to: mutatedLine.trim(), mutatedLine });
                }
            }
        }
    });
    return mutants;
}

function makeWorkspace(n) {
    let dir = fs.mkdtempSync(path.join(os.tmpdir(), `imapflow-mutant-${n}-`));
    for (let entry of ['src', 'test', 'package.json', 'tsconfig.json', 'tsconfig.base.json']) {
        fs.cpSync(path.join(ROOT, entry), path.join(dir, entry), { recursive: true });
    }
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
    return dir;
}

function runTests(dir, tests) {
    return new Promise(resolve => {
        execFile(
            process.execPath,
            // a mutant that makes a test hang fails that test at the per-test timeout, and one
            // that blocks the event loop is stopped by the process timeout; both count as killed.
            // The unmutated suites finish in a few seconds
            ['--import', 'tsx', '--test', '--test-force-exit', '--test-concurrency=1', '--test-timeout=10000', ...tests],
            {
                cwd: dir,
                env: Object.assign({}, process.env, { FUZZ_ITERATIONS: '60' }),
                timeout: 2 * 60 * 1000,
                maxBuffer: 64 * 1024 * 1024
            },
            err => resolve(!err)
        );
    });
}

/**
 * Rebuilds the mutants of an earlier run from their recorded lines, so they can be re-run after
 * the tests or the code changed. A mutant whose line no longer exists is reported and skipped
 */
function mutantsFromSurvivors(file) {
    let mutants = [];
    for (let survivor of JSON.parse(fs.readFileSync(file, 'utf8'))) {
        let lines = fs.readFileSync(path.join(ROOT, survivor.file), 'utf8').split('\n');
        // the same text can appear on several lines, the one nearest the recorded line number is the one
        let index = -1;
        lines.forEach((line, i) => {
            if (line.trim() === survivor.from && (index < 0 || Math.abs(i + 1 - survivor.line) < Math.abs(index + 1 - survivor.line))) {
                index = i;
            }
        });
        if (index < 0) {
            console.log(`GONE ${survivor.file}:${survivor.line} ${survivor.from}`);
            continue;
        }
        let indent = lines[index].match(/^\s*/)[0];
        mutants.push({ ...survivor, line: index + 1, mutatedLine: indent + survivor.to });
    }
    return mutants;
}

let mutants = opt('survivors', '') ? mutantsFromSurvivors(opt('survivors')) : FILES.flatMap(mutantsOf);
if (MAX && mutants.length > MAX) {
    // an even sample over all files
    let step = mutants.length / MAX;
    mutants = Array.from({ length: MAX }, (_, i) => mutants[Math.floor(i * step)]);
}
console.log(`${mutants.length} mutants, ${WORKERS} workers, tests: ${ALL_TESTS.length} files`);

let workspaces = Array.from({ length: WORKERS }, (_, i) => makeWorkspace(i));
try {
    // the unmutated code must pass first, otherwise every mutant would look killed
    if (!(await runTests(workspaces[0], ALL_TESTS))) {
        console.error('the suites fail on the unmutated code');
        process.exitCode = 1;
    } else {
        let next = 0;
        let killed = 0;
        let survivors = [];
        let started = Date.now();
        await Promise.all(
            workspaces.map(async dir => {
                while (next < mutants.length) {
                    let mutant = mutants[next++];
                    let target = path.join(dir, mutant.file);
                    let original = fs.readFileSync(target, 'utf8');
                    let lines = original.split('\n');
                    lines[mutant.line - 1] = mutant.mutatedLine;
                    fs.writeFileSync(target, lines.join('\n'));
                    let passed = await runTests(dir, testsFor(mutant.file));
                    fs.writeFileSync(target, original);
                    if (passed) {
                        survivors.push(mutant);
                        console.log(`SURVIVED ${mutant.file}:${mutant.line}\n    - ${mutant.from}\n    + ${mutant.to}`);
                    } else {
                        killed++;
                    }
                    let done = killed + survivors.length;
                    if (done % 20 === 0) {
                        console.log(`  ${done}/${mutants.length} done, ${survivors.length} survived, ${Math.round((Date.now() - started) / 1000)}s`);
                    }
                }
            })
        );

        console.log(`\nkilled ${killed}, survived ${survivors.length}, mutation score ${((100 * killed) / mutants.length).toFixed(1)}%`);
        let report = path.join(os.tmpdir(), 'imapflow-mutation-survivors.json');
        survivors.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
        fs.writeFileSync(
            report,
            JSON.stringify(
                survivors.map(({ mutatedLine: _mutatedLine, ...m }) => m),
                null,
                2
            )
        );
        console.log(`survivors written to ${report}`);
    }
} finally {
    for (let dir of workspaces) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
