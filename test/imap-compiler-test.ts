/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parser, compiler } from '../src/handler/imap-handler.js';

// Returns the error a compile attempt raised, or undefined when it succeeded.
// Several cases below assert that a token can never reach the wire, and the
// try/catch is the only interesting part of each. Takes either an attributes
// array (compiled under a default tag/command) or a full response object.
const compileError = async (input: any) => {
    try {
        await compiler(Array.isArray(input) ? { tag: 'A', command: 'CMD', attributes: input } : input);
    } catch (err) {
        return err;
    }
};

describe('imap-compiler', () => {
    it('IMAP Compiler: mixed', async () => {
        const command =
            '* FETCH (ENVELOPE ("Mon, 2 Sep 2013 05:30:13 -0700 (PDT)" NIL ((NIL NIL "andris" "kreata.ee")) ((NIL NIL "andris" "kreata.ee")) ((NIL NIL "andris" "kreata.ee")) ((NIL NIL "andris" "tr.ee")) NIL NIL NIL "<-4730417346358914070@unknownmsgid>") BODYSTRUCTURE (("MESSAGE" "RFC822" NIL NIL NIL "7BIT" 105 (NIL NIL ((NIL NIL "andris" "kreata.ee")) ((NIL NIL "andris" "kreata.ee")) ((NIL NIL "andris" "kreata.ee")) ((NIL NIL "andris" "pangalink.net")) NIL NIL "<test1>" NIL) ("TEXT" "PLAIN" NIL NIL NIL "7BIT" 12 0 NIL NIL NIL) 5 NIL NIL NIL)("MESSAGE" "RFC822" NIL NIL NIL "7BIT" 83 (NIL NIL ((NIL NIL "andris" "kreata.ee")) ((NIL NIL "andris" "kreata.ee")) ((NIL NIL "andris" "kreata.ee")) ((NIL NIL "andris" "pangalink.net")) NIL NIL "NIL" NIL) ("TEXT" "PLAIN" NIL NIL NIL "7BIT" 12 0 NIL NIL NIL) 4 NIL NIL NIL)("TEXT" "HTML" ("CHARSET" "utf-8") NIL NIL "QUOTED-PRINTABLE" 19 0 NIL NIL NIL) "MIXED" ("BOUNDARY" "----mailcomposer-?=_1-1328088797399") NIL NIL))';
        const parsed = await parser(command, {
            allowUntagged: true
        } as any);
        const compiled = (await compiler(parsed)).toString();
        assert.equal(compiled, command);
    });
    it('IMAP Compiler: no attributes', async () =>
        assert.equal(
            (
                await compiler({
                    tag: '*',
                    command: 'CMD'
                })
            ).toString(),
            '* CMD'
        ));
    it('IMAP Compiler: TEXT', async () =>
        assert.equal(
            (
                await compiler({
                    tag: '*',
                    command: 'CMD',
                    attributes: [
                        {
                            type: 'TEXT',
                            value: 'Tere tere!'
                        }
                    ]
                })
            ).toString(),
            '* CMD Tere tere!'
        ));
    it('IMAP Compiler: NUMBER attribute', async () =>
        assert.equal(
            (
                await compiler({
                    tag: '*',
                    command: 'CMD',
                    attributes: [
                        {
                            type: 'NUMBER',
                            value: 42
                        }
                    ]
                })
            ).toString(),
            '* CMD 42'
        ));
    it('IMAP Compiler: NUMBER attribute defaults missing value to 0', async () =>
        assert.equal(
            (
                await compiler({
                    tag: '*',
                    command: 'CMD',
                    attributes: [{ type: 'NUMBER' }]
                })
            ).toString(),
            '* CMD 0'
        ));
    it('IMAP Compiler: unrecognized value type compiles to empty buffer', async () => {
        // A SEQUENCE node whose value is neither string/number/Buffer falls through
        // formatRespEntry to an empty Buffer rather than throwing.
        let out = (
            await (compiler as any)({
                tag: '*',
                command: 'CMD',
                attributes: [{ type: 'SEQUENCE', value: { unexpected: true } }]
            })
        ).toString();
        assert.equal(out, '* CMD ');
    });
    it('IMAP Compiler: SECTION', async () =>
        assert.equal(
            (
                await compiler({
                    tag: '*',
                    command: 'CMD',
                    attributes: [
                        {
                            type: 'SECTION',
                            section: [
                                {
                                    type: 'ATOM',
                                    value: 'ALERT'
                                }
                            ]
                        }
                    ]
                })
            ).toString(),
            '* CMD [ALERT]'
        ));
    it('IMAP Compiler: escaped ATOM', async () =>
        assert.equal(
            (
                await compiler({
                    tag: '*',
                    command: 'CMD',
                    attributes: [
                        {
                            type: 'ATOM',
                            value: 'ALERT'
                        },
                        {
                            type: 'ATOM',
                            value: '\\ALERT'
                        },
                        {
                            type: 'ATOM',
                            value: 'NO ALERT'
                        }
                    ]
                })
            ).toString(),
            '* CMD ALERT \\ALERT "NO ALERT"'
        ));
    it('IMAP Compiler: SEQUENCE', async () =>
        assert.equal(
            (
                await compiler({
                    tag: '*',
                    command: 'CMD',
                    attributes: [
                        {
                            type: 'SEQUENCE',
                            value: '*:4,5,6'
                        }
                    ]
                })
            ).toString(),
            '* CMD *:4,5,6'
        ));
    it('IMAP Compiler: NIL', async () =>
        assert.equal(
            (
                await compiler({
                    tag: '*',
                    command: 'CMD',
                    attributes: [null, null]
                })
            ).toString(),
            '* CMD NIL NIL'
        ));
    it('IMAP Compiler: quoted TEXT', async () =>
        assert.equal(
            (
                await compiler({
                    tag: '*',
                    command: 'CMD',
                    attributes: [
                        {
                            type: 'String',
                            value: 'Tere tere!',
                            sensitive: true
                        },
                        'Vana kere'
                    ]
                })
            ).toString(),
            '* CMD "Tere tere!" "Vana kere"'
        ));
    it('IMAP Compiler: keep short strings', async () =>
        assert.equal(
            (
                await compiler(
                    {
                        tag: '*',
                        command: 'CMD',
                        attributes: [
                            {
                                type: 'String',
                                value: 'Tere tere!'
                            },
                            'Vana kere'
                        ]
                    },
                    { asArray: false, isLogging: true }
                )
            ).toString(),
            '* CMD "Tere tere!" "Vana kere"'
        ));
    it('IMAP Compiler: hide sensitive strings', async () =>
        assert.equal(
            (
                await compiler(
                    {
                        tag: '*',
                        command: 'CMD',
                        attributes: [
                            {
                                type: 'String',
                                value: 'Tere tere!',
                                sensitive: true
                            },
                            'Vana kere'
                        ]
                    },
                    { asArray: false, isLogging: true }
                )
            ).toString(),
            '* CMD "(* value hidden *)" "Vana kere"'
        ));
    it('IMAP Compiler: hide long strings', async () =>
        assert.equal(
            (
                await compiler(
                    {
                        tag: '*',
                        command: 'CMD',
                        attributes: [
                            {
                                type: 'String',
                                value: 'Tere tere! Tere tere! Tere tere! Tere tere! Tere tere! Tere tere! Tere tere! Tere tere! Tere tere! Tere tere! Tere tere! Tere tere! Tere tere! Tere tere! Tere tere! Tere tere! Tere tere! Tere tere! Tere tere! Tere tere!'
                            },
                            'Vana kere'
                        ]
                    },
                    { asArray: false, isLogging: true }
                )
            ).toString(),
            '* CMD "(* 219B string *)" "Vana kere"'
        ));
    it('IMAP Compiler: no command', async () =>
        assert.equal(
            (
                await compiler({
                    tag: '*',
                    attributes: [
                        1,
                        {
                            type: 'ATOM',
                            value: 'EXPUNGE'
                        }
                    ]
                })
            ).toString(),
            '* 1 EXPUNGE'
        ));
    it('IMAP Compiler: LITERAL text', async () =>
        assert.equal(
            (
                await compiler({
                    tag: '*',
                    command: 'CMD',
                    attributes: [
                        // keep indentation
                        {
                            type: 'LITERAL',
                            value: 'Tere tere!'
                        },
                        'Vana kere'
                    ]
                })
            ).toString(),
            '* CMD {10}\r\nTere tere! "Vana kere"'
        ));
    it('IMAP Compiler: LITERAL literal', async () =>
        assert.equal(
            (
                await compiler({
                    tag: '*',
                    command: 'CMD',
                    attributes: [
                        // keep indentation
                        {
                            type: 'LITERAL',
                            value: 'Tere\x00 tere!',
                            isLiteral8: false
                        },
                        'Vana kere'
                    ]
                })
            ).toString(),
            '* CMD {11}\r\nTere\x00 tere! "Vana kere"'
        ));
    it('IMAP Compiler: LITERAL literal8', async () =>
        assert.equal(
            (
                await compiler({
                    tag: '*',
                    command: 'CMD',
                    attributes: [
                        // keep indentation
                        {
                            type: 'LITERAL',
                            value: 'Tere\x00 tere!',
                            isLiteral8: true
                        },
                        'Vana kere'
                    ]
                })
            ).toString(),
            '* CMD ~{11}\r\nTere\x00 tere! "Vana kere"'
        ));

    // RFC 7888 (folded into IMAP4rev2): with LITERAL- a non-synchronizing literal
    // marker {n+} is only allowed for literals of up to 4096 bytes - anything larger
    // must use the synchronizing {n} form, in every compilation mode
    it('IMAP Compiler: LITERAL- oversized literal stays synchronizing in single-buffer mode', async () => {
        let payload = 'a'.repeat(4097);
        let compiled = (
            await compiler(
                {
                    tag: '*',
                    command: 'CMD',
                    attributes: [
                        {
                            type: 'LITERAL',
                            value: payload
                        }
                    ]
                },
                { literalMinus: true }
            )
        ).toString();
        assert.ok(compiled.startsWith('* CMD {4097}\r\n'), `must not use a non-synchronizing marker: ${compiled.slice(0, 20)}`);
    });
    it('IMAP Compiler: LITERAL- boundary: exactly 4096 bytes is non-synchronizing', async () => {
        let payload = 'a'.repeat(4096);
        let parts = (
            await compiler(
                {
                    tag: '*',
                    command: 'CMD',
                    attributes: [
                        {
                            type: 'LITERAL',
                            value: payload
                        }
                    ]
                },
                { asArray: true, literalMinus: true }
            )
        ).map(entry => entry.toString());
        assert.equal(parts.length, 1, 'literal must be appended inline without a continuation break');
        assert.ok(parts[0].startsWith('* CMD {4096+}\r\n'));
    });
    it('IMAP Compiler: LITERAL- boundary: 4097 bytes falls back to synchronizing', async () => {
        let payload = 'a'.repeat(4097);
        let parts = (
            await compiler(
                {
                    tag: '*',
                    command: 'CMD',
                    attributes: [
                        {
                            type: 'LITERAL',
                            value: payload
                        }
                    ]
                },
                { asArray: true, literalMinus: true }
            )
        ).map(entry => entry.toString());
        assert.equal(parts.length, 2, 'literal must wait for a continuation response');
        assert.ok(parts[0].endsWith('{4097}\r\n'), `marker must be synchronizing: ${parts[0].slice(-12)}`);
    });

    // The literal size marker counts octets, not UTF-16 code units - a unicode string
    // value must declare its UTF-8 byte length
    it('IMAP Compiler: LITERAL declares byte length for unicode string values', async () => {
        let compiled = await compiler({
            tag: '*',
            command: 'CMD',
            attributes: [
                {
                    type: 'LITERAL',
                    value: 'Sõnumid'
                }
            ]
        });
        assert.equal(compiled.toString(), '* CMD {8}\r\nSõnumid');
    });
    it('IMAP Compiler: LITERAL array 1', async () =>
        assert.deepEqual(
            (
                await compiler(
                    {
                        tag: '*',
                        command: 'CMD',
                        attributes: [
                            {
                                type: 'LITERAL',
                                value: 'Tere tere!'
                            },
                            {
                                type: 'LITERAL',
                                value: 'Vana kere'
                            }
                        ]
                    },
                    { asArray: true }
                )
            ).map(entry => entry.toString()),
            ['* CMD {10}\r\n', 'Tere tere! {9}\r\n', 'Vana kere']
        ));
    it('IMAP Compiler: LITERAL array 2', async () =>
        assert.deepEqual(
            (
                await compiler(
                    {
                        tag: '*',
                        command: 'CMD',
                        attributes: [
                            {
                                type: 'LITERAL',
                                value: 'Tere tere!'
                            },
                            {
                                type: 'LITERAL',
                                value: 'Vana kere'
                            },
                            'zzz'
                        ]
                    },
                    { asArray: true }
                )
            ).map(entry => entry.toString()),
            ['* CMD {10}\r\n', 'Tere tere! {9}\r\n', 'Vana kere "zzz"']
        ));
    it('IMAP Compiler: LITERALPLUS array', async () =>
        assert.deepEqual(
            (
                await compiler(
                    {
                        tag: '*',
                        command: 'CMD',
                        attributes: [
                            {
                                type: 'LITERAL',
                                value: 'Tere tere!'
                            },
                            {
                                type: 'LITERAL',
                                value: 'Vana kere'
                            },
                            'zzz'
                        ]
                    },
                    { asArray: true, literalPlus: true }
                )
            ).map(entry => entry.toString()),
            ['* CMD {10+}\r\nTere tere! {9+}\r\nVana kere "zzz"']
        ));
    it('IMAP Compiler: LITERAL array without tag/command', async () =>
        assert.deepEqual(
            (
                await compiler(
                    {
                        attributes: [
                            {
                                type: 'LITERAL',
                                value: 'Tere tere!'
                            },
                            {
                                type: 'LITERAL',
                                value: 'Vana kere'
                            }
                        ]
                    },
                    { asArray: true }
                )
            ).map(entry => entry.toString()),
            ['{10}\r\n', 'Tere tere! {9}\r\n', 'Vana kere']
        ));
    it('IMAP Compiler: LITERAL byte length', async () =>
        assert.deepEqual(
            (
                await compiler(
                    {
                        tag: '*',
                        command: 'CMD',
                        attributes: [
                            {
                                type: 'LITERAL',
                                value: 'Tere tere!'
                            },
                            'Vana kere'
                        ]
                    },
                    { asArray: false, isLogging: true }
                )
            ).toString(),
            '* CMD "(* 10B literal *)" "Vana kere"'
        ));
    it('IMAP Compiler: MongoDB binary object is unwrapped', async () => {
        // Create a non-Buffer object with a .buffer property (simulates MongoDB Binary)
        const mongoBinary = { buffer: Buffer.from('test data') };
        const compiled = (
            await (compiler as any)({
                tag: '*',
                command: 'CMD',
                attributes: [mongoBinary]
            })
        ).toString();
        // The buffer content should appear in the output (unwrapped from the MongoDB binary wrapper)
        assert.ok(compiled.includes('test data'), 'should contain the buffer content after unwrapping');
        assert.ok(compiled.includes('CMD'), 'should contain command');
    });
    it('IMAP Compiler: long string truncated in logging mode', async () => {
        const longString = 'x'.repeat(150);
        const compiled = (
            await compiler(
                {
                    tag: '*',
                    command: 'CMD',
                    attributes: [longString]
                },
                { asArray: false, isLogging: true }
            )
        ).toString();
        assert.ok(compiled.includes('150B string'), 'should show byte count instead of content');
        assert.ok(!compiled.includes('x'.repeat(150)), 'should not contain the full string');
    });
    it('IMAP Compiler: literal truncated in logging mode', async () => {
        const compiled = (
            await compiler(
                {
                    tag: '*',
                    command: 'CMD',
                    attributes: [{ type: 'LITERAL', value: Buffer.alloc(200) }]
                },
                { asArray: false, isLogging: true }
            )
        ).toString();
        assert.ok(compiled.includes('200B literal'), 'should show byte count for literal');
    });
    it('IMAP Compiler: partial range in SECTION', async () => {
        const compiled = (
            await compiler({
                tag: '*',
                command: 'CMD',
                attributes: [
                    {
                        type: 'SECTION',
                        section: [{ type: 'ATOM', value: 'BODY' }],
                        partial: [0, 50]
                    }
                ]
            })
        ).toString();
        assert.ok(compiled.includes('<0.50>'), 'should contain partial range <0.50>');
    });
    it('IMAP Compiler: SEQUENCE rejects values that are not sequence sets', async () => {
        // Sequence sets are written verbatim, so a range string that reached the
        // compiler unvalidated would put a second command on the wire
        for (let value of ['1\r\nZZ1 LOGOUT', '1 2', '1;2', 'ALL', '1:2)', '1\t2', Buffer.from('1\r\nZZ NOOP')]) {
            let err: any = await compileError([{ type: 'SEQUENCE', value }]);
            assert.equal(err && err.code, 'InvalidSequenceSet', `${JSON.stringify(value.toString())} must be rejected`);
        }
    });
    it('IMAP Compiler: SEQUENCE accepts every valid sequence-set form', async () => {
        // '$' is the RFC 5182 SEARCHRES saved-result marker, valid as the entire set
        for (let value of ['1', '*', '1:*', '*:1', '1,3,5', '1:3,7,9:*', '4294967295', '$']) {
            const compiled = (await compiler({ tag: 'A', command: 'FETCH', attributes: [{ type: 'SEQUENCE', value }] })).toString();
            assert.equal(compiled, `A FETCH ${value}`);
        }

        // '$' only stands for the whole set, never an element of one
        for (let value of ['$,1', '1,$', '$:2']) {
            let err: any = await compileError([{ type: 'SEQUENCE', value }]);
            assert.equal(err && err.code, 'InvalidSequenceSet', `${JSON.stringify(value)} must be rejected`);
        }
    });
    it('IMAP Compiler: SEQUENCE validation stays linear on huge valid sets', async () => {
        // The regex this replaced overflowed the engine's backtrack stack with an
        // uncoded RangeError at roughly a million comma-separated elements - a set
        // a fetch over a large mailbox can legitimately produce
        const huge = Array.from({ length: 1500000 }, (_, i) => i + 1).join(',');
        const compiled = await compiler({ tag: 'A', command: 'FETCH', attributes: [{ type: 'SEQUENCE', value: huge }] });
        assert.ok(compiled.toString().endsWith(huge), 'the huge but valid set must compile');
    });
    it('IMAP Compiler: SEQUENCE validation is skipped when logging', async () => {
        // The incoming token parser accepts sequence-shaped tokens the strict grammar
        // rejects (an ESEARCH set like "1:2:3", a folder name like "12:30:00"). Every
        // parsed server response is re-compiled for the log, so a throw here would let
        // one quirky server line kill the whole connection.
        for (let value of ['1:2:3', '12:30:00', '1,2:3:4']) {
            const compiled = (await compiler({ tag: '*', command: 'OK', attributes: [{ type: 'SEQUENCE', value }] }, { isLogging: true })).toString();
            assert.equal(compiled, `* OK ${value}`, 'logging re-compile must pass the token through');
        }
    });
    it('IMAP Compiler: tag and command cannot carry a line terminator', async () => {
        // The tag/command preamble is written verbatim ahead of any token, so it goes
        // through the same choke point as everything else
        let err: any = await compileError({ tag: 'A\r\nZZ LOGOUT', command: 'NOOP' });
        assert.equal(err && err.code, 'InvalidTokenValue', 'CRLF in the tag must be rejected');

        err = await compileError({ tag: 'A', command: 'NOOP\r\nZZ LOGOUT' });
        assert.equal(err && (err as any).code, 'InvalidTokenValue', 'CRLF in the command must be rejected');
    });
    it('IMAP Compiler: quoted strings use IMAP escaping, not JSON escaping', async () => {
        // Only DQUOTE and backslash have escapes in the IMAP grammar - a tab must
        // survive as a raw byte rather than becoming a literal backslash-t
        const compiled = (await compiler({ tag: 'A', command: 'CMD', attributes: [{ type: 'STRING', value: 'a\tb"c\\d' }] })).toString();
        assert.equal(compiled, 'A CMD "a\tb\\"c\\\\d"');
    });
    it('IMAP Compiler: quoted strings reject CR, LF and NUL', async () => {
        for (let value of ['a\rb', 'a\nb', 'a\0b']) {
            let err: any = await compileError([{ type: 'STRING', value }]);
            assert.equal(err && err.code, 'InvalidStringValue', `${JSON.stringify(value)} cannot be sent as a quoted string`);
        }
    });
    it('IMAP Compiler: a mailbox name with CRLF cannot reach the wire', async () => {
        // Paths travel as ATOM tokens and get quoted when they fall outside ATOM-CHAR
        let err: any = await compileError([{ type: 'ATOM', value: 'INBOX\r\nZZ LOGOUT' }]);
        assert.equal(err && err.code, 'InvalidStringValue');
    });
    it('IMAP Compiler: response text cannot carry a line terminator', async () => {
        // TEXT is written verbatim as well, so it gets the same guarantee even though
        // only the parser produces it today
        let err: any = await compileError([{ type: 'TEXT', value: 'oops\r\nZZ NOOP' }]);
        assert.equal(err && err.code, 'InvalidTextValue');
    });
    it('IMAP Compiler: NUMBER coerces its value instead of writing it through', async () => {
        const compiled = (await compiler({ tag: 'A', command: 'CMD', attributes: [{ type: 'NUMBER', value: '1\r\nZZ NOOP' }] })).toString();
        assert.equal(compiled, 'A CMD 0', 'a non-numeric value must not reach the wire verbatim');
        assert.equal((await compiler({ tag: 'A', command: 'CMD', attributes: [{ type: 'NUMBER', value: '42' }] })).toString(), 'A CMD 42');
    });
    it('IMAP Compiler: numeric tokens clamp to bounded non-negative integers', async () => {
        // Infinity, negatives and unsafe magnitudes would otherwise emit bytes outside
        // the number alphabet ("Infinity", "-5", "1e+300") and get a server BAD blamed
        // on the server instead of the caller
        for (let [value, expected] of [
            [Infinity, '0'],
            ['Infinity', '0'],
            [-5, '0'],
            ['2e21', '0'],
            [4.6, '5']
        ]) {
            const compiled = (await compiler({ tag: 'A', command: 'CMD', attributes: [{ type: 'NUMBER', value }] })).toString();
            assert.equal(compiled, `A CMD ${expected}`, `${JSON.stringify(value)} must clamp to ${expected}`);
        }
    });
    it('IMAP Compiler: partial range coerces its elements', async () => {
        // The partial range is the last token component written verbatim, so it is
        // coerced rather than joined as-is
        const attributes = [{ type: 'ATOM', value: 'BODY.PEEK', section: [], partial: ['0>\r\nZZ NOOP'] }];
        const compiled = (await (compiler as any)({ tag: 'A', command: 'FETCH', attributes })).toString();
        assert.equal(compiled, 'A FETCH BODY.PEEK[]<0>');

        const normal = (
            await compiler({ tag: 'A', command: 'FETCH', attributes: [{ type: 'ATOM', value: 'BODY.PEEK', section: [], partial: [0, 1024] }] })
        ).toString();
        assert.equal(normal, 'A FETCH BODY.PEEK[]<0.1024>');

        // Floats and unbounded numerics clamp the same way NUMBER tokens do, so no
        // non-digit byte ("512.5", "Infinity") can appear inside the partial range
        const float = (
            await compiler({ tag: 'A', command: 'FETCH', attributes: [{ type: 'ATOM', value: 'BODY.PEEK', section: [], partial: [0, 512.5] }] })
        ).toString();
        assert.equal(float, 'A FETCH BODY.PEEK[]<0.513>');

        const unbounded = (
            await (compiler as any)({
                tag: 'A',
                command: 'FETCH',
                attributes: [{ type: 'ATOM', value: 'BODY.PEEK', section: [], partial: ['Infinity', '2e21'] }]
            })
        ).toString();
        assert.equal(unbounded, 'A FETCH BODY.PEEK[]<0.0>');
    });
    it('IMAP Compiler: logging output never throws on unsendable values', async () => {
        // The logging pass must survive whatever the wire pass refuses, so a rejected
        // command can still be logged
        const compiled = (
            await compiler(
                {
                    tag: 'A',
                    command: 'LOGIN',
                    attributes: [{ type: 'STRING', value: 'a\r\nb' }]
                },
                { isLogging: true }
            )
        ).toString();
        assert.ok(compiled.includes('\\r\\n'), 'control characters stay escaped for the log');
    });
});
