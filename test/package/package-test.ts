import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// These tests exercise the compiled output in dist/ (built by the pretest
// script) through the package.json exports map, the same way an installed
// copy of the package is loaded. Node resolves the package name to the
// package itself when the specifier is used from inside the package.
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Non-literal specifiers keep TypeScript from resolving the built types at
// type-check time, when dist/ may not exist yet
const packageName: string = 'imapflow';
const subpath = (name: string) => packageName + '/lib/' + name;

const hasDist = fs.existsSync(path.join(root, 'dist', 'cjs', 'imap-flow.js')) && fs.existsSync(path.join(root, 'dist', 'esm', 'imap-flow.js'));

const clientOptions = {
    host: '127.0.0.1',
    port: 993,
    logger: false as const,
    auth: { user: 'test', pass: 'secret' }
};

describe('Built package', { timeout: 30 * 1000, skip: hasDist ? false : 'dist/ is not built, run npm run build first' }, () => {
    it('ships both module formats with type declarations', () => {
        for (const format of ['esm', 'cjs']) {
            assert.ok(fs.existsSync(path.join(root, 'dist', format, 'imap-flow.js')), format + ' entry point');
            assert.ok(fs.existsSync(path.join(root, 'dist', format, 'imap-flow.d.ts')), format + ' type declarations');
            assert.ok(fs.existsSync(path.join(root, 'dist', format, 'commands', 'fetch.d.ts')), format + ' command declarations');
            assert.ok(fs.existsSync(path.join(root, 'dist', format, 'handler', 'imap-stream.d.ts')), format + ' handler declarations');
        }
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, 'dist', 'esm', 'package.json'), 'utf8')), { type: 'module' });
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, 'dist', 'cjs', 'package.json'), 'utf8')), { type: 'commonjs' });
    });

    it('points every exports entry at an existing file', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        assert.strictEqual(pkg.exports['.'].import, './dist/esm/imap-flow.js');
        assert.strictEqual(pkg.exports['.'].require, './dist/cjs/imap-flow.js');
        assert.strictEqual(pkg.main, './dist/cjs/imap-flow.js');
        assert.ok(fs.existsSync(path.join(root, pkg.types)), 'types entry exists');
        for (const [subpath, entry] of Object.entries(pkg.exports)) {
            if (subpath.includes('*')) {
                continue;
            }
            const targets = typeof entry === 'string' ? [entry] : Object.values(entry as Record<string, string>);
            for (const target of targets) {
                assert.ok(fs.existsSync(path.join(root, target)), subpath + ' points at a missing file ' + target);
            }
        }
    });

    it('does not ship the TypeScript sources or the test suite', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        assert.ok(pkg.files.includes('dist'));
        assert.ok(!pkg.files.includes('src'));
        assert.ok(!pkg.files.includes('test'));
    });

    describe('CommonJS build', () => {
        it('gives every module the shape its declaration file announces', () => {
            // A module whose declaration has a default export is loaded as that
            // export itself (the build rewrites it, see scripts/build.js), the
            // entry point keeps both forms, and everything else is a plain
            // exports object
            const cjsRoot = path.join(root, 'dist', 'cjs');
            const files = (fs.readdirSync(cjsRoot, { recursive: true }) as string[]).filter(name => name.endsWith('.js'));
            assert.ok(files.length > 30, 'expected the compiled modules under dist/cjs');
            for (const name of files) {
                const declaration = fs.readFileSync(path.join(cjsRoot, name.replace(/\.js$/, '.d.ts')), 'utf8');
                const hasDefault = /^export default /m.test(declaration);
                const mod = require(path.join(cjsRoot, name));
                if (name === 'imap-flow.js') {
                    assert.strictEqual(typeof mod.ImapFlow, 'function', name);
                    assert.strictEqual(mod.default.ImapFlow, mod.ImapFlow, name);
                } else if (hasDefault) {
                    assert.ok(typeof mod === 'function' || typeof mod === 'object', name + ' should load as its default export');
                    assert.strictEqual(mod.default, mod, name + ' should alias .default to itself');
                    assert.ok(!Object.keys(mod).includes('default'), name + ' default alias is not enumerable');
                } else {
                    assert.strictEqual(typeof mod, 'object', name + ' should load as an exports object');
                    assert.strictEqual(mod.__esModule, true, name);
                    assert.ok(!('default' in mod), name + ' should not have a default export');
                }
            }
        });

        it('resolves require() to the CommonJS entry point', () => {
            assert.strictEqual(require.resolve(packageName), path.join(root, 'dist', 'cjs', 'imap-flow.js'));
        });

        it('exposes the public API as properties of the module', () => {
            const imapflow = require(packageName);
            assert.strictEqual(typeof imapflow.ImapFlow, 'function');
            assert.strictEqual(typeof imapflow.AuthenticationFailure, 'function');
            assert.strictEqual(imapflow.default.ImapFlow, imapflow.ImapFlow);
            assert.strictEqual(typeof imapflow.ImapFlow.version, 'string');
        });

        it('constructs a client from the CommonJS build', () => {
            const { ImapFlow } = require(packageName);
            const client = new ImapFlow(clientOptions);
            assert.strictEqual(typeof client.connect, 'function');
            assert.strictEqual(typeof client.getMailboxLock, 'function');
            assert.strictEqual(client.usable, false);
            client.close();
            assert.strictEqual(client.isClosed, true);
        });

        it('keeps deep imports returning the exported function or class', () => {
            for (const name of ['commands/fetch', 'commands/fetch.js', 'commands/select', 'commands/idle', 'handler/imap-parser', 'handler/imap-compiler']) {
                const mod = require(subpath(name));
                assert.strictEqual(typeof mod, 'function', name);
                assert.strictEqual(mod.default, mod, name);
            }
            const commands = require(subpath('imap-commands'));
            assert.ok(commands instanceof Map, 'imap-commands is the command Map itself');
            assert.strictEqual(typeof commands.get('FETCH'), 'function');
        });

        it('keeps deep imports of utility modules returning their members', () => {
            for (const [name, member] of [
                ['tools', 'packMessageRange'],
                ['tools', 'expandRange'],
                ['tools', 'AuthenticationFailure'],
                ['handler/imap-handler', 'parser'],
                ['handler/imap-handler', 'compiler'],
                ['handler/imap-stream', 'ImapStream'],
                ['handler/token-parser', 'TokenParser'],
                ['search-compiler', 'searchCompiler'],
                ['special-use', 'specialUse'],
                ['proxy-connection', 'proxyConnection'],
                ['connection-deadline', 'ConnectionDeadline'],
                ['limited-passthrough', 'LimitedPassthrough'],
                ['jp-decoder', 'JPDecoder'],
                ['charsets', 'resolveCharset']
            ]) {
                assert.strictEqual(typeof require(subpath(name))[member], 'function', name + '.' + member);
            }
        });
    });

    describe('ES module build', () => {
        it('resolves import to the ES module entry point', async () => {
            const url = new URL('../../dist/esm/imap-flow.js', import.meta.url).href;
            const direct = await import(url);
            const byName = await import(packageName);
            assert.strictEqual(byName.ImapFlow, direct.ImapFlow);
        });

        it('exposes named and default exports', async () => {
            const imapflow = await import(packageName);
            assert.strictEqual(typeof imapflow.ImapFlow, 'function');
            assert.strictEqual(typeof imapflow.AuthenticationFailure, 'function');
            assert.strictEqual(imapflow.default.ImapFlow, imapflow.ImapFlow);
            assert.strictEqual(imapflow.default.AuthenticationFailure, imapflow.AuthenticationFailure);
        });

        it('constructs a client from the ES module build', async () => {
            const { ImapFlow } = await import(packageName);
            const client = new ImapFlow(clientOptions);
            assert.strictEqual(typeof client.connect, 'function');
            assert.strictEqual(client.usable, false);
            client.close();
            assert.strictEqual(client.isClosed, true);
        });

        it('exposes deep imports as default and named exports', async () => {
            const { default: fetch } = await import(subpath('commands/fetch'));
            assert.strictEqual(typeof fetch, 'function');
            const { default: commands } = await import(subpath('imap-commands'));
            assert.ok(commands instanceof Map);
            const tools = await import(subpath('tools'));
            assert.strictEqual(typeof tools.packMessageRange, 'function');
            const handler = await import(subpath('handler/imap-handler'));
            assert.strictEqual(typeof handler.parser, 'function');
            assert.strictEqual(typeof handler.compiler, 'function');
        });
    });
});
