/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0, new-cap: 0 */

'use strict';

const proxyquire = require('proxyquire').noCallThru();

const { parser, compiler } = require('../lib/handler/imap-handler');
const { ImapStream } = require('../lib/handler/imap-stream');
const { ParserInstance } = require('../lib/handler/parser-instance');
const { TokenParser } = require('../lib/handler/token-parser');
const { searchCompiler } = require('../lib/search-compiler');

let asyncWrapper = (test, handler) => {
    handler(test)
        .then(() => test.done())
        .catch(err => {
            test.ifError(err);
            test.done();
        });
};

// ============================================================================
// imap-compiler.js
// ============================================================================

// formatRespEntry: `return entry` when entry is a Buffer (line 23-25). A literal
// whose value is a Buffer, compiled in non-logging mode, passes the Buffer straight
// through formatRespEntry.
module.exports['imap-compiler: Buffer literal value passes through formatRespEntry'] = test =>
    asyncWrapper(test, async test => {
        let out = (
            await compiler({
                tag: '*',
                command: 'CMD',
                attributes: [{ type: 'LITERAL', value: Buffer.from('hello world') }]
            })
        ).toString();
        test.equal(out, '* CMD {11}\r\nhello world');
    });

// number node === 0 -> `Math.round(node) || 0` falls back to 0 (line 117). A bare
// numeric attribute of 0 exercises the `|| 0` right side.
module.exports['imap-compiler: bare number 0 attribute uses fallback'] = test =>
    asyncWrapper(test, async test => {
        let out = (
            await compiler({
                tag: '*',
                command: 'CMD',
                attributes: [0]
            })
        ).toString();
        test.equal(out, '* CMD 0');
    });

// LITERAL node with empty value -> `!node.value ? 0 : ...` true side (line 133).
module.exports['imap-compiler: LITERAL with empty string value yields {0}'] = test =>
    asyncWrapper(test, async test => {
        let out = (
            await compiler({
                tag: '*',
                command: 'CMD',
                attributes: [{ type: 'LITERAL', value: '' }]
            })
        ).toString();
        test.equal(out, '* CMD {0}\r\n');
    });

// LITERAL- (literalMinus) with literal <= 4096 bytes in asArray mode -> exercises the
// `(literalMinus && literalLength <= 4096)` branch of canAppend (line 139) and usePlus.
module.exports['imap-compiler: LITERAL- inlines small literals in asArray mode'] = test =>
    asyncWrapper(test, async test => {
        let out = (
            await compiler(
                {
                    tag: '*',
                    command: 'CMD',
                    attributes: [{ type: 'LITERAL', value: 'small' }]
                },
                { asArray: true, literalMinus: true }
            )
        ).map(entry => entry.toString());
        // LITERAL- still appends a non-synchronizing '+' marker for inlined literals
        test.deepEqual(out, ['* CMD {5+}\r\nsmall']);
    });

// LITERAL- with a literal larger than 4096 bytes in asArray mode -> canAppend false,
// so the synchronizing-literal split path runs. The new resp segment is seeded with
// `formatRespEntry(node.value, true) || []`. Using a Buffer value keeps formatRespEntry
// returning the Buffer (the `|| []` right side, line 156, is the focus together with the
// split branch).
module.exports['imap-compiler: LITERAL- large literal splits (synchronizing) in asArray mode'] = test =>
    asyncWrapper(test, async test => {
        let big = Buffer.alloc(5000, 0x61); // 5000 bytes > 4096
        let out = (
            await compiler(
                {
                    tag: '*',
                    command: 'CMD',
                    attributes: [{ type: 'LITERAL', value: big }]
                },
                { asArray: true, literalMinus: true }
            )
        ).map(entry => entry.toString());
        test.equal(out.length, 2);
        test.equal(out[0], '* CMD {5000}\r\n');
        test.equal(out[1], big.toString());
    });

// Synchronizing literal whose value is not a recognized type -> formatRespEntry(value, true)
// returns null, so `|| []` kicks in (line 156 right side) and the seeded resp is empty.
module.exports['imap-compiler: synchronizing literal with non-buffer value seeds empty segment'] = test =>
    asyncWrapper(test, async test => {
        let out = (
            await compiler(
                {
                    tag: '*',
                    command: 'CMD',
                    // value is an object that is neither string/number/Buffer but has a numeric
                    // length, so literalLength resolves to 10 while formatRespEntry(value, true)
                    // returns null -> the seeded resp falls back to [] (line 156 right side).
                    attributes: [{ type: 'LITERAL', value: { length: 10 } }]
                },
                { asArray: true }
            )
        ).map(entry => entry.toString());
        // Only the header segment is emitted; the empty seeded data segment is dropped
        // because `if (resp.length)` is false at the end.
        test.deepEqual(out, ['* CMD {10}\r\n']);
    });

// STRING node with falsy value -> `(node.value || '')` right side (line 165).
module.exports['imap-compiler: STRING with empty/falsy value compiles to empty quoted string'] = test =>
    asyncWrapper(test, async test => {
        let out = (
            await compiler({
                tag: '*',
                command: 'CMD',
                attributes: [{ type: 'STRING', value: '' }]
            })
        ).toString();
        test.equal(out, '* CMD ""');
    });

// response.attributes that is a single (non-array) object -> `[].concat(response.attributes)`
// right side of the ternary on line 215.
module.exports['imap-compiler: single non-array attributes object is wrapped'] = test =>
    asyncWrapper(test, async test => {
        let out = (
            await compiler({
                tag: '*',
                command: 'CMD',
                attributes: { type: 'ATOM', value: 'EXPUNGE' }
            })
        ).toString();
        test.equal(out, '* CMD EXPUNGE');
    });

// ============================================================================
// imap-stream.js
// ============================================================================

// Provide a logger object so the constructor takes the `this.options.logger` branch
// (lines 61-62) instead of creating a child logger.
module.exports['imap-stream: explicit logger option is used as-is'] = test => {
    let calls = [];
    let fakeLogger = {
        trace: m => calls.push(m),
        child: () => {
            throw new Error('child should not be called when a logger is supplied');
        }
    };
    let stream = new ImapStream({ cid: 'x', logger: fakeLogger });
    test.equal(stream.log, fakeLogger, 'supplied logger object is used directly');
    test.done();
};

// checkLiteralMarker: a line that is all digits + "}\r\n" but has no opening "{" makes
// the backward scan run off the start of the line, hitting the final `return false`
// (line 154).
module.exports['imap-stream: checkLiteralMarker returns false when no opening brace is found'] = test => {
    let stream = new ImapStream({ cid: 'x' });
    // "12}\n": scan finds '}', then digits '2','1', runs past index 0 -> final return false
    test.equal(stream.checkLiteralMarker(Buffer.from('12}\n')), false);
    // also exercise the CRLF variant
    test.equal(stream.checkLiteralMarker(Buffer.from('99}\r\n')), false);
    test.done();
};

// _transform with a string chunk -> `chunk = Buffer.from(chunk, encoding)` (lines 299-301).
// Call _transform directly with a string so the typeof === 'string' branch runs.
// The string->Buffer conversion and byte counting happen synchronously, before the
// chunk is queued for async processing, so readBytesCounter reflects the decoded length.
module.exports['imap-stream: _transform converts string chunks to Buffers'] = test => {
    let stream = new ImapStream({ cid: 'x' });
    stream._transform('A1 NOOP\r\n', 'utf8', () => {});
    test.equal(stream.readBytesCounter, Buffer.byteLength('A1 NOOP\r\n'), 'decoded byte length was counted');
    stream.destroy();
    test.done();
};

// ============================================================================
// parser-instance.js
// ============================================================================

// Drive ParserInstance directly so getCommand is reached with a falsy (empty-string)
// command and a non-"+" tag, exercising the `(this.command || '')` right side (line 71).
// This state is not produced by normal parsing, so we construct it explicitly.
module.exports['parser-instance: getCommand falls back to empty string for falsy command'] = test =>
    asyncWrapper(test, async test => {
        let inst = new ParserInstance('* ', {});
        inst.tag = '*'; // not '+', so the early continuation branch is skipped
        // Pre-set command to a value getElement would have produced, then blank the
        // remainder so the `if (!this.command)` re-fetch path throws? No - instead we
        // set command to empty string and clear remainder so getElement is NOT re-run
        // is impossible (empty string is falsy). Use a getElement stub on the instance
        // to deterministically yield an empty command without touching lib/ source.
        inst.getElement = async () => '';
        let command = await inst.getCommand();
        test.equal(command, '', 'command is the empty string');
    });

// ============================================================================
// token-parser.js
// ============================================================================

// Construct TokenParser directly with a falsy str, undefined options and a falsy
// startPos to cover the `str || ''` (40), `options || {}` (41) and `startPos || 0`
// (45) fallbacks. These cannot occur through ParserInstance.getAttributes (which
// guards against an empty remainder), so direct construction is required.
module.exports['token-parser: constructor fallbacks for empty str / no options / zero startPos'] = test =>
    asyncWrapper(test, async test => {
        let parent = { command: 'FETCH' };
        let tp = new TokenParser(parent, 0, undefined, undefined);
        test.equal(tp.str, '');
        test.deepEqual(tp.options, {});
        test.equal(tp.pos, 0);
        let attrs = await tp.getAttributes();
        test.deepEqual(attrs, []);
    });

// Cover the `(node.type || '')` fallback (line 85) by walking a tree that contains a
// closed child node with a falsy type. Normal parsing always assigns a type, so the
// tree is constructed explicitly.
module.exports['token-parser: walk handles a closed node with a falsy type'] = test =>
    asyncWrapper(test, async test => {
        let parent = { command: 'FETCH' };
        let tp = new TokenParser(parent, 0, '', {});
        tp.tree = {
            type: 'TREE',
            isClosed: true,
            childNodes: [{ type: false, isClosed: true, value: '', childNodes: [] }]
        };
        let attrs = await tp.getAttributes();
        test.deepEqual(attrs, []);
    });

// ============================================================================
// search-compiler.js
// ============================================================================

let createMockConnection = (options = {}) => ({
    capabilities: new Map(options.capabilities || [['IMAP4rev1', true]]),
    enabled: new Set(options.enabled || []),
    mailbox: options.mailbox || {
        flags: new Set(['\\Seen']),
        permanentFlags: new Set(['\\*'])
    }
});

// setOpt NOT branch (lines 46-48): EMAILID/THREADID call setOpt with an unguarded
// params[term]. Passing the boolean `false` as the value reaches `value === false`
// and pushes a leading NOT atom. (A `null` value also enters this branch, but setOpt
// then crashes on `value.toString()` at line 56, so `false` is the only value that
// drives this branch to completion through the public API.)
module.exports['search-compiler: threadid false triggers setOpt NOT branch'] = test => {
    let connection = createMockConnection({ capabilities: [['OBJECTID', true]] });
    let attrs = searchCompiler(connection, { threadid: false });
    test.deepEqual(attrs, [
        { type: 'ATOM', value: 'NOT' },
        { type: 'ATOM', value: 'THREADID' },
        { type: 'ATOM', value: 'false' }
    ]);
    test.done();
};

// KEYWORD search where the flag is NOT usable via canUseFlag but IS already present in
// the mailbox flags set -> exercises the `mailbox.flags.has(flag)` right side (line 297).
module.exports['search-compiler: keyword already present in mailbox flags is accepted'] = test => {
    // permanentFlags has no '\\*', so canUseFlag(mailbox, customFlag) is false, but the
    // flag is in mailbox.flags, so the OR short-circuits to the right operand.
    let connection = createMockConnection({
        mailbox: {
            flags: new Set(['$Label1']),
            permanentFlags: new Set(['\\Seen']) // no '\\*' wildcard -> custom flags not auto-usable
        }
    });
    let attrs = searchCompiler(connection, { keyword: '$Label1' });
    test.deepEqual(attrs, [
        { type: 'ATOM', value: 'KEYWORD' },
        { type: 'ATOM', value: '$Label1' }
    ]);
    test.done();
};

// ============================================================================
// proxy-connection.js
// ============================================================================

// attachEarlyErrorHandler guard (lines 23-25): the proxy client returns a truthy socket
// that lacks an `.on` method, so the guard returns early.
module.exports['proxy-connection: socket without .on skips early error handler attach'] = async test => {
    let logger = { info: () => {}, error: () => {} };
    let bareSocket = { write() {}, end() {} }; // truthy, but no .on
    const { proxyConnection } = proxyquire('../lib/proxy-connection', {
        'nodemailer/lib/smtp-connection/http-proxy-client': (url, port, host, cb) => {
            cb(null, bareSocket);
        },
        socks: { SocksClient: {} },
        dns: { promises: { resolve: async () => ['127.0.0.1'] } },
        net: { isIP: () => true }
    });

    let socket = await proxyConnection(logger, 'http://proxy.example.com:8080', '192.168.1.1', 993);
    test.equal(socket, bareSocket, 'socket returned unchanged');
    test.ok(!('_earlyErrorHandler' in socket), 'no early error handler was attached to a socket without .on');
    test.done();
};

// Sanity: untagged parse still round-trips, just to keep the parser import exercised.
module.exports['sanity: parser/compiler round-trip'] = test =>
    asyncWrapper(test, async test => {
        let parsed = await parser('* OK Ready', { allowUntagged: true });
        test.equal(parsed.command, 'OK');
    });
