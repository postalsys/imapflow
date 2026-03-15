/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

'use strict';

const { parser, compiler } = require('../lib/handler/imap-handler');

let asyncWrapper = (test, handler) => {
    handler(test)
        .then(() => test.done())
        .catch(err => {
            test.ifError(err);
            test.done();
        });
};

module.exports['IMAP Compiler: mixed'] = test =>
    asyncWrapper(test, async test => {
        const command =
            '* FETCH (ENVELOPE ("Mon, 2 Sep 2013 05:30:13 -0700 (PDT)" NIL ((NIL NIL "andris" "kreata.ee")) ((NIL NIL "andris" "kreata.ee")) ((NIL NIL "andris" "kreata.ee")) ((NIL NIL "andris" "tr.ee")) NIL NIL NIL "<-4730417346358914070@unknownmsgid>") BODYSTRUCTURE (("MESSAGE" "RFC822" NIL NIL NIL "7BIT" 105 (NIL NIL ((NIL NIL "andris" "kreata.ee")) ((NIL NIL "andris" "kreata.ee")) ((NIL NIL "andris" "kreata.ee")) ((NIL NIL "andris" "pangalink.net")) NIL NIL "<test1>" NIL) ("TEXT" "PLAIN" NIL NIL NIL "7BIT" 12 0 NIL NIL NIL) 5 NIL NIL NIL)("MESSAGE" "RFC822" NIL NIL NIL "7BIT" 83 (NIL NIL ((NIL NIL "andris" "kreata.ee")) ((NIL NIL "andris" "kreata.ee")) ((NIL NIL "andris" "kreata.ee")) ((NIL NIL "andris" "pangalink.net")) NIL NIL "NIL" NIL) ("TEXT" "PLAIN" NIL NIL NIL "7BIT" 12 0 NIL NIL NIL) 4 NIL NIL NIL)("TEXT" "HTML" ("CHARSET" "utf-8") NIL NIL "QUOTED-PRINTABLE" 19 0 NIL NIL NIL) "MIXED" ("BOUNDARY" "----mailcomposer-?=_1-1328088797399") NIL NIL))';
        const parsed = await parser(command, {
            allowUntagged: true
        });
        const compiled = (await compiler(parsed)).toString();
        test.equal(compiled, command);
    });

module.exports['IMAP Compiler: no attributes'] = test =>
    asyncWrapper(test, async test =>
        test.equal(
            (
                await compiler({
                    tag: '*',
                    command: 'CMD'
                })
            ).toString(),
            '* CMD'
        )
    );

module.exports['IMAP Compiler: TEXT'] = test =>
    asyncWrapper(test, async test =>
        test.equal(
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
        )
    );

module.exports['IMAP Compiler: SECTION'] = test =>
    asyncWrapper(test, async test =>
        test.equal(
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
        )
    );

module.exports['IMAP Compiler: escaped ATOM'] = test =>
    asyncWrapper(test, async test =>
        test.equal(
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
        )
    );

module.exports['IMAP Compiler: SEQUENCE'] = test =>
    asyncWrapper(test, async test =>
        test.equal(
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
        )
    );

module.exports['IMAP Compiler: NIL'] = test =>
    asyncWrapper(test, async test =>
        test.equal(
            (
                await compiler({
                    tag: '*',
                    command: 'CMD',
                    attributes: [null, null]
                })
            ).toString(),
            '* CMD NIL NIL'
        )
    );

module.exports['IMAP Compiler: quoted TEXT'] = test =>
    asyncWrapper(test, async test =>
        test.equal(
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
        )
    );

module.exports['IMAP Compiler: keep short strings'] = test =>
    asyncWrapper(test, async test =>
        test.equal(
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
        )
    );

module.exports['IMAP Compiler: hide sensitive strings'] = test =>
    asyncWrapper(test, async test =>
        test.equal(
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
        )
    );

module.exports['IMAP Compiler: hide long strings'] = test =>
    asyncWrapper(test, async test =>
        test.equal(
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
        )
    );

module.exports['IMAP Compiler: no command'] = test =>
    asyncWrapper(test, async test =>
        test.equal(
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
        )
    );

module.exports['IMAP Compiler: LITERAL text'] = test =>
    asyncWrapper(test, async test =>
        test.equal(
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
        )
    );

module.exports['IMAP Compiler: LITERAL literal'] = test =>
    asyncWrapper(test, async test =>
        test.equal(
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
        )
    );

module.exports['IMAP Compiler: LITERAL literal8'] = test =>
    asyncWrapper(test, async test =>
        test.equal(
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
        )
    );

module.exports['IMAP Compiler: LITERAL array 1'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual(
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
        )
    );

module.exports['IMAP Compiler: LITERAL array 2'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual(
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
        )
    );

module.exports['IMAP Compiler: LITERALPLUS array'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual(
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
        )
    );

module.exports['IMAP Compiler: LITERAL array without tag/command'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual(
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
        )
    );

module.exports['IMAP Compiler: LITERAL byte length'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual(
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
        )
    );

module.exports['IMAP Compiler: MongoDB binary object is unwrapped'] = test =>
    asyncWrapper(test, async test => {
        // Create a non-Buffer object with a .buffer property (simulates MongoDB Binary)
        const mongoBinary = { buffer: Buffer.from('test data') };
        const compiled = (
            await compiler({
                tag: '*',
                command: 'CMD',
                attributes: [mongoBinary]
            })
        ).toString();
        // The buffer content should appear in the output (unwrapped from the MongoDB binary wrapper)
        test.ok(compiled.includes('test data'), 'should contain the buffer content after unwrapping');
        test.ok(compiled.includes('CMD'), 'should contain command');
    });

module.exports['IMAP Compiler: long string truncated in logging mode'] = test =>
    asyncWrapper(test, async test => {
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
        test.ok(compiled.includes('150B string'), 'should show byte count instead of content');
        test.ok(!compiled.includes('x'.repeat(150)), 'should not contain the full string');
    });

module.exports['IMAP Compiler: literal truncated in logging mode'] = test =>
    asyncWrapper(test, async test => {
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
        test.ok(compiled.includes('200B literal'), 'should show byte count for literal');
    });

module.exports['IMAP Compiler: partial range in SECTION'] = test =>
    asyncWrapper(test, async test => {
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
        test.ok(compiled.includes('<0.50>'), 'should contain partial range <0.50>');
    });
