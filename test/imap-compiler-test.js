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
        const compiled = await compiler(parsed);
        test.equal(compiled, command);
    });

module.exports['IMAP Compiler: no attributes'] = test =>
    asyncWrapper(test, async test =>
        test.equal(
            await compiler({
                tag: '*',
                command: 'CMD'
            }),
            '* CMD'
        )
    );

module.exports['IMAP Compiler: TEXT'] = test =>
    asyncWrapper(test, async test =>
        test.equal(
            await compiler({
                tag: '*',
                command: 'CMD',
                attributes: [
                    {
                        type: 'TEXT',
                        value: 'Tere tere!'
                    }
                ]
            }),
            '* CMD Tere tere!'
        )
    );

module.exports['IMAP Compiler: SECTION'] = test =>
    asyncWrapper(test, async test =>
        test.equal(
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
            }),
            '* CMD [ALERT]'
        )
    );

module.exports['IMAP Compiler: escaped ATOM'] = test =>
    asyncWrapper(test, async test =>
        test.equal(
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
            }),
            '* CMD ALERT \\ALERT "NO ALERT"'
        )
    );

module.exports['IMAP Compiler: SEQUENCE'] = test =>
    asyncWrapper(test, async test =>
        test.equal(
            await compiler({
                tag: '*',
                command: 'CMD',
                attributes: [
                    {
                        type: 'SEQUENCE',
                        value: '*:4,5,6'
                    }
                ]
            }),
            '* CMD *:4,5,6'
        )
    );

module.exports['IMAP Compiler: NIL'] = test =>
    asyncWrapper(test, async test =>
        test.equal(
            await compiler({
                tag: '*',
                command: 'CMD',
                attributes: [null, null]
            }),
            '* CMD NIL NIL'
        )
    );

module.exports['IMAP Compiler: quoted TEXT'] = test =>
    asyncWrapper(test, async test =>
        test.equal(
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
            }),
            '* CMD "Tere tere!" "Vana kere"'
        )
    );

module.exports['IMAP Compiler: keep short strings'] = test =>
    asyncWrapper(test, async test =>
        test.equal(
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
            ),
            '* CMD "Tere tere!" "Vana kere"'
        )
    );

module.exports['IMAP Compiler: hide sensitive strings'] = test =>
    asyncWrapper(test, async test =>
        test.equal(
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
            ),
            '* CMD "(* value hidden *)" "Vana kere"'
        )
    );

module.exports['IMAP Compiler: hide long strings'] = test =>
    asyncWrapper(test, async test =>
        test.equal(
            await compiler(
                {
                    tag: '*',
                    command: 'CMD',
                    attributes: [
                        {
                            type: 'String',
                            value:
                                'Tere tere! Tere tere! Tere tere! Tere tere! Tere tere! Tere tere! Tere tere! Tere tere! Tere tere! Tere tere! Tere tere! Tere tere! Tere tere! Tere tere! Tere tere! Tere tere! Tere tere! Tere tere! Tere tere! Tere tere!'
                        },
                        'Vana kere'
                    ]
                },
                { asArray: false, isLogging: true }
            ),
            '* CMD "(* 219B string *)" "Vana kere"'
        )
    );

module.exports['IMAP Compiler: no command'] = test =>
    asyncWrapper(test, async test =>
        test.equal(
            await compiler({
                tag: '*',
                attributes: [
                    1,
                    {
                        type: 'ATOM',
                        value: 'EXPUNGE'
                    }
                ]
            }),
            '* 1 EXPUNGE'
        )
    );

module.exports['IMAP Compiler: LITERAL text'] = test =>
    asyncWrapper(test, async test =>
        test.equal(
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
            }),
            '* CMD {10}\r\nTere tere! "Vana kere"'
        )
    );

module.exports['IMAP Compiler: LITERAL array 1'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual(
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
            ),
            ['* CMD {10}\r\n', 'Tere tere! {9}\r\n', 'Vana kere']
        )
    );

module.exports['IMAP Compiler: LITERAL array 2'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual(
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
            ),
            ['* CMD {10}\r\n', 'Tere tere! {9}\r\n', 'Vana kere "zzz"']
        )
    );

module.exports['IMAP Compiler: LITERALPLUS array'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual(
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
            ),
            ['* CMD {10+}\r\nTere tere! {9+}\r\nVana kere "zzz"']
        )
    );

module.exports['IMAP Compiler: LITERAL array without tag/command'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual(
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
            ),
            ['{10}\r\n', 'Tere tere! {9}\r\n', 'Vana kere']
        )
    );

module.exports['IMAP Compiler: LITERAL byte length'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual(
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
            ),
            '* CMD "(* 10B literal *)" "Vana kere"'
        )
    );
