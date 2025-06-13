/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

'use strict';

const { parser } = require('../lib/handler/imap-handler');
const mimetorture = require('./fixtures/serialized-mimetorture');

let asyncWrapper = (test, handler) => {
    handler(test)
        .then(() => test.done())
        .catch(err => {
            test.ifError(err);
            test.done();
        });
};

let asyncWrapperFail = (test, handler) => {
    handler(test)
        .then(() => {
            test.ok(false);
            test.done();
        })
        .catch(err => {
            test.ok(err);
            test.done();
        });
};

module.exports['IMAP Parser: Tags: get TAG'] = test => asyncWrapper(test, async test => test.equal((await parser('TAG1 CMD')).tag, 'TAG1'));
module.exports['IMAP Parser: Tags: space before TAG'] = test => asyncWrapperFail(test, async test => test.ok(await parser(' TAG CMD')));
module.exports['IMAP Parser: Tags: fail empty TAG'] = test => asyncWrapperFail(test, async test => test.ok(await parser('')));
module.exports['IMAP Parser: Tags: * TAG'] = test => asyncWrapper(test, async test => test.equal((await parser('* CMD')).tag, '*'));
module.exports['IMAP Parser: Tags: + TAG'] = test => asyncWrapper(test, async test => test.equal((await parser('+ CMD')).tag, '+'));
module.exports['IMAP Parser: Tags: fail TAG only'] = test => asyncWrapperFail(test, async test => test.ok(await parser('TAG1')));
module.exports['IMAP Parser: Tags: fail invalid char in TAG'] = test => asyncWrapperFail(test, async test => test.ok(await parser('TAG"1 CMD')));

module.exports['IMAP Parser: Command: single'] = test => asyncWrapper(test, async test => test.equal((await parser('TAG1 CMD')).command, 'CMD'));
module.exports['IMAP Parser: Command: multi word'] = test =>
    asyncWrapper(test, async test => test.equal((await parser('TAG1 UID FETCH')).command, 'UID FETCH'));
module.exports['IMAP Parser: Command: fail extra ws'] = test => asyncWrapperFail(test, async test => test.ok(await parser('TAG1  CMD')));
module.exports['IMAP Parser: Command: fail empty command'] = test => asyncWrapperFail(test, async test => test.ok(await parser('TAG1 ')));
module.exports['IMAP Parser: Command: fail invalid char in command'] = test => asyncWrapperFail(test, async test => test.ok(await parser('TAG1 CM=D')));

module.exports['IMAP Parser: Args: allow trailing whitespace and empty arguments'] = test =>
    asyncWrapper(test, async test => test.deepEqual(await parser('* SEARCH '), { tag: '*', command: 'SEARCH' }));

module.exports['IMAP Parser: Attributes: single atom'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual((await parser('TAG1 CMD FED')).attributes, [
            {
                type: 'ATOM',
                value: 'FED'
            }
        ])
    );

module.exports['IMAP Parser: Attributes: multiple atoms'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual((await parser('TAG1 CMD FED TED')).attributes, [
            {
                type: 'ATOM',
                value: 'FED'
            },
            {
                type: 'ATOM',
                value: 'TED'
            }
        ])
    );

module.exports['IMAP Parser: Attributes: special char in atom'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual((await parser('TAG1 CMD %')).attributes, [
            {
                type: 'ATOM',
                value: '%'
            }
        ])
    );

module.exports['IMAP Parser: Attributes: escaped char in atom'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual((await parser('TAG1 CMD \\*')).attributes, [
            {
                type: 'ATOM',
                value: '\\*'
            }
        ])
    );

module.exports['IMAP Parser: Attributes: sub list'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual((await parser('12.82 STATUS [Gmail].Trash (UIDNEXT UNSEEN HIGHESTMODSEQ)')).attributes, [
            {
                type: 'ATOM',
                value: '[Gmail].Trash'
            },
            [
                {
                    type: 'ATOM',
                    value: 'UIDNEXT'
                },
                {
                    type: 'ATOM',
                    value: 'UNSEEN'
                },
                {
                    type: 'ATOM',
                    value: 'HIGHESTMODSEQ'
                }
            ]
        ])
    );

module.exports['IMAP Parser: Attributes: single string'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual((await parser('TAG1 CMD "ABCDE"')).attributes, [
            {
                type: 'STRING',
                value: 'ABCDE'
            }
        ])
    );

module.exports['IMAP Parser: Attributes: multiple strings'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual((await parser('TAG1 CMD "ABCDE" "DEFGH"')).attributes, [
            {
                type: 'STRING',
                value: 'ABCDE'
            },
            {
                type: 'STRING',
                value: 'DEFGH'
            }
        ])
    );

module.exports['IMAP Parser: Attributes: invalid char in string'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual((await parser('* 1 FETCH (BODY[] "\xc2")')).attributes, [
            {
                type: 'ATOM',
                value: 'FETCH'
            },
            [
                {
                    type: 'ATOM',
                    value: 'BODY',
                    section: []
                },
                {
                    type: 'STRING',
                    value: '\xc2'
                }
            ]
        ])
    );

module.exports['IMAP Parser: Lists: single atom'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual((await parser('TAG1 CMD (1234)')).attributes, [
            [
                {
                    type: 'ATOM',
                    value: '1234'
                }
            ]
        ])
    );

module.exports['IMAP Parser: Lists: multiple atoms'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual((await parser('TAG1 CMD (1234 TERE)')).attributes, [
            [
                {
                    type: 'ATOM',
                    value: '1234'
                },
                {
                    type: 'ATOM',
                    value: 'TERE'
                }
            ]
        ])
    );

module.exports['IMAP Parser: Lists: multiple lists'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual((await parser('TAG1 CMD (1234)(TERE)')).attributes, [
            [
                {
                    type: 'ATOM',
                    value: '1234'
                }
            ],
            [
                {
                    type: 'ATOM',
                    value: 'TERE'
                }
            ]
        ])
    );

module.exports['IMAP Parser: Lists: extra whitespace in start of list'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual((await parser('TAG1 CMD ( 1234)')).attributes, [
            [
                {
                    type: 'ATOM',
                    value: '1234'
                }
            ]
        ])
    );

module.exports['IMAP Parser: Lists: extra whitespace in end of list'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual((await parser('TAG1 CMD (1234 )')).attributes, [
            [
                {
                    type: 'ATOM',
                    value: '1234'
                }
            ]
        ])
    );

module.exports['IMAP Parser: Lists: extra whitespace after list'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual((await parser('TAG1 CMD (1234) ')).attributes, [
            [
                {
                    type: 'ATOM',
                    value: '1234'
                }
            ]
        ])
    );

module.exports['IMAP Parser: Lists: nested list 1'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual((await parser('TAG1 CMD (((TERE)) VANA)')).attributes, [
            [
                [
                    [
                        {
                            type: 'ATOM',
                            value: 'TERE'
                        }
                    ]
                ],
                {
                    type: 'ATOM',
                    value: 'VANA'
                }
            ]
        ])
    );

module.exports['IMAP Parser: Lists: nested list 2'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual((await parser('TAG1 CMD (( (TERE)) VANA)')).attributes, [
            [
                [
                    [
                        {
                            type: 'ATOM',
                            value: 'TERE'
                        }
                    ]
                ],
                {
                    type: 'ATOM',
                    value: 'VANA'
                }
            ]
        ])
    );

module.exports['IMAP Parser: Lists: nested list 3'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual((await parser('TAG1 CMD (((TERE) ) VANA)')).attributes, [
            [
                [
                    [
                        {
                            type: 'ATOM',
                            value: 'TERE'
                        }
                    ]
                ],
                {
                    type: 'ATOM',
                    value: 'VANA'
                }
            ]
        ])
    );

module.exports['IMAP Parser: Literals: single literal'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual((await parser('TAG1 CMD {4}\r\n', { literals: [Buffer.from('abcd')] })).attributes, [
            {
                type: 'LITERAL',
                value: Buffer.from('abcd')
            }
        ])
    );

module.exports['IMAP Parser: Literals: literal with NULL'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual((await parser('TAG1 CMD {4}\r\n', { literals: [Buffer.from('ab\x00d')] })).attributes, [
            {
                type: 'LITERAL',
                value: Buffer.from('ab\x00d')
            }
        ])
    );

module.exports['IMAP Parser: Literals: literal8'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual((await parser('TAG1 CMD ~{4}\r\n', { literals: [Buffer.from('ab\x00d')] })).attributes, [
            {
                type: 'LITERAL',
                value: Buffer.from('ab\x00d')
            }
        ])
    );

module.exports['IMAP Parser: Literals: unexpected literal8 prefix'] = test =>
    asyncWrapper(test, async test => {
        try {
            await parser('TAG1 CMD ~\r\n');
            test.ok(false, 'Must throw');
        } catch (err) {
            test.ok(err, 'Error must exist');
        }
    });

module.exports['IMAP Parser: Literals: multiple literals'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual((await parser('TAG1 CMD {4}\r\n {4}\r\n', { literals: [Buffer.from('abcd'), Buffer.from('kere')] })).attributes, [
            {
                type: 'LITERAL',
                value: Buffer.from('abcd')
            },
            {
                type: 'LITERAL',
                value: Buffer.from('kere')
            }
        ])
    );

module.exports['IMAP Parser: Literals: list'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual((await parser('TAG1 CMD ({4}\r\n {4}\r\n)', { literals: [Buffer.from('abcd'), Buffer.from('kere')] })).attributes, [
            [
                {
                    type: 'LITERAL',
                    value: Buffer.from('abcd')
                },
                {
                    type: 'LITERAL',
                    value: Buffer.from('kere')
                }
            ]
        ])
    );

module.exports['IMAP Parser: Tags: fail extra ws after literal'] = test =>
    asyncWrapperFail(test, async test => test.ok(await parser('TAG1 CMD {4}\r\n{4}  \r\n', { literals: [Buffer.from('abcd'), Buffer.from('kere')] })));

module.exports['IMAP Parser: Literals: allow zero length literal in the end of a list'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual((await parser('TAG1 CMD ({0}\r\n)')).attributes, [
            [
                {
                    type: 'LITERAL',
                    value: Buffer.from('')
                }
            ]
        ])
    );

module.exports['IMAP Parser: Section: empty'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual((await parser('TAG1 CMD BODY[]')).attributes, [
            {
                type: 'ATOM',
                value: 'BODY',
                section: []
            }
        ])
    );

module.exports['IMAP Parser: Section: list'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual((await parser('TAG1 CMD BODY[(KERE)]')).attributes, [
            {
                type: 'ATOM',
                value: 'BODY',
                section: [
                    [
                        {
                            type: 'ATOM',
                            value: 'KERE'
                        }
                    ]
                ]
            }
        ])
    );

module.exports['IMAP Parser: Section: allow trailing ws'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual((await parser('TAG1 CMD BODY[HEADER.FIELDS (Subject From) ]')).attributes, [
            {
                type: 'ATOM',
                value: 'BODY',
                section: [
                    {
                        type: 'ATOM',
                        value: 'HEADER.FIELDS'
                    },
                    [
                        {
                            type: 'ATOM',
                            value: 'Subject'
                        },
                        {
                            type: 'ATOM',
                            value: 'From'
                        }
                    ]
                ]
            }
        ])
    );

module.exports['IMAP Parser: Readable: simple'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual(await parser('* OK Hello world!'), {
            command: 'OK',
            tag: '*',
            attributes: [
                {
                    type: 'TEXT',
                    value: 'Hello world!'
                }
            ]
        })
    );

module.exports['IMAP Parser: Readable: section'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual(await parser('* OK [CAPABILITY IDLE] Hello world!'), {
            command: 'OK',
            tag: '*',
            attributes: [
                {
                    section: [
                        {
                            type: 'ATOM',
                            value: 'CAPABILITY'
                        },
                        {
                            type: 'ATOM',
                            value: 'IDLE'
                        }
                    ],
                    type: 'ATOM',
                    value: ''
                },
                {
                    type: 'TEXT',
                    value: 'Hello world!'
                }
            ]
        })
    );

// USEATTR is from RFC6154; we are testing that just an ATOM
// on its own will parse successfully here.  (All of the
// RFC5530 codes are also single atoms.)
module.exports['IMAP Parser: Section: USEATTR'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual(await parser('TAG1 OK [USEATTR] \\All not supported'), {
            tag: 'TAG1',
            command: 'OK',
            attributes: [
                {
                    type: 'ATOM',
                    value: '',
                    section: [
                        {
                            type: 'ATOM',
                            value: 'USEATTR'
                        }
                    ]
                },
                {
                    type: 'TEXT',
                    value: '\\All not supported'
                }
            ]
        })
    );

// RFC5267 defines the NOUPDATE error.  Including for quote /
// string coverage.
module.exports['IMAP Parser: Section: NOUPDATE'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual(await parser('* NO [NOUPDATE "B02"] Too many contexts'), {
            tag: '*',
            command: 'NO',
            attributes: [
                {
                    type: 'ATOM',
                    value: '',
                    section: [
                        {
                            type: 'ATOM',
                            value: 'NOUPDATE'
                        },
                        {
                            type: 'STRING',
                            value: 'B02'
                        }
                    ]
                },
                {
                    type: 'TEXT',
                    value: 'Too many contexts'
                }
            ]
        })
    );

// RFC5464 defines the METADATA response code; adding this to
// ensure the transition for when '2199' hits ']' is handled
// safely.
module.exports['IMAP Parser: Section: METADATA'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual(await parser('TAG1 OK [METADATA LONGENTRIES 2199] GETMETADATA complete'), {
            tag: 'TAG1',
            command: 'OK',
            attributes: [
                {
                    type: 'ATOM',
                    value: '',
                    section: [
                        {
                            type: 'ATOM',
                            value: 'METADATA'
                        },
                        {
                            type: 'ATOM',
                            value: 'LONGENTRIES'
                        },
                        {
                            type: 'ATOM',
                            value: '2199'
                        }
                    ]
                },
                {
                    type: 'TEXT',
                    value: 'GETMETADATA complete'
                }
            ]
        })
    );

// RFC4467 defines URLMECH.  Included because of the example
// third atom involves base64-encoding which is somewhat unusual
module.exports['IMAP Parser: Section: URLMECH'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual(await parser('TAG1 OK [URLMECH INTERNAL XSAMPLE=P34OKhO7VEkCbsiYY8rGEg==] done'), {
            tag: 'TAG1',
            command: 'OK',
            attributes: [
                {
                    type: 'ATOM',
                    value: '',
                    section: [
                        {
                            type: 'ATOM',
                            value: 'URLMECH'
                        },
                        {
                            type: 'ATOM',
                            value: 'INTERNAL'
                        },
                        {
                            type: 'ATOM',
                            value: 'XSAMPLE=P34OKhO7VEkCbsiYY8rGEg=='
                        }
                    ]
                },
                {
                    type: 'TEXT',
                    value: 'done'
                }
            ]
        })
    );

// RFC2221 defines REFERRAL where the argument is an imapurl
// (defined by RFC2192 which is obsoleted by RFC5092) which
// is significantly more complicated than the rest of the IMAP
// grammar and which was based on the RFC2060 grammar where
// resp_text_code included:
//   atom [SPACE 1*<any TEXT_CHAR except ']'>]
// So this is just a test case of our explicit special-casing
// of REFERRAL.
module.exports['IMAP Parser: Section: REFERRAL'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual(await parser('TAG1 NO [REFERRAL IMAP://user;AUTH=*@SERVER2/] Remote Server'), {
            tag: 'TAG1',
            command: 'NO',
            attributes: [
                {
                    type: 'ATOM',
                    value: '',
                    section: [
                        {
                            type: 'ATOM',
                            value: 'REFERRAL'
                        },
                        {
                            type: 'ATOM',
                            value: 'IMAP://user;AUTH=*@SERVER2/'
                        }
                    ]
                },
                {
                    type: 'TEXT',
                    value: 'Remote Server'
                }
            ]
        })
    );

// PERMANENTFLAGS is from RFC3501.  Its syntax is also very
// similar to BADCHARSET, except BADCHARSET has astrings
// inside the list.
module.exports['IMAP Parser: Section: PERMANENTFLAGS'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual(await parser('* OK [PERMANENTFLAGS (de:hacking $label kt-evalution [css3-page] \\*)] Flags permitted.'), {
            tag: '*',
            command: 'OK',
            attributes: [
                {
                    type: 'ATOM',
                    value: '',
                    section: [
                        {
                            type: 'ATOM',
                            value: 'PERMANENTFLAGS'
                        },
                        [
                            {
                                type: 'ATOM',
                                value: 'de:hacking'
                            },
                            {
                                type: 'ATOM',
                                value: '$label'
                            },
                            {
                                type: 'ATOM',
                                value: 'kt-evalution'
                            },
                            {
                                type: 'ATOM',
                                value: '[css3-page]'
                            },
                            {
                                type: 'ATOM',
                                value: '\\*'
                            }
                        ]
                    ]
                },
                {
                    type: 'TEXT',
                    value: 'Flags permitted.'
                }
            ]
        })
    );

// COPYUID is from RFC4315 and included the previously failing
// parsing situation of a sequence terminated by ']' rather than
// whitespace.
module.exports['IMAP Parser: Section: COPYUID'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual(await parser('TAG1 OK [COPYUID 4 1417051618:1417051620 1421730687:1421730689] COPY completed'), {
            tag: 'TAG1',
            command: 'OK',
            attributes: [
                {
                    type: 'ATOM',
                    value: '',
                    section: [
                        {
                            type: 'ATOM',
                            value: 'COPYUID'
                        },
                        {
                            type: 'ATOM',
                            value: '4'
                        },
                        {
                            type: 'SEQUENCE',
                            value: '1417051618:1417051620'
                        },
                        {
                            type: 'SEQUENCE',
                            value: '1421730687:1421730689'
                        }
                    ]
                },
                {
                    type: 'TEXT',
                    value: 'COPY completed'
                }
            ]
        })
    );

// MODIFIED is from RFC4551 and is basically the same situation
// as the COPYUID case, but in this case our example sequences
// have commas in them.  (Note that if there was no comma, the
// '7,9' payload would end up an ATOM.)
module.exports['IMAP Parser: Section: MODIFIED'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual(await parser('TAG1 OK [MODIFIED 7,9] Conditional STORE failed'), {
            tag: 'TAG1',
            command: 'OK',
            attributes: [
                {
                    type: 'ATOM',
                    value: '',
                    section: [
                        {
                            type: 'ATOM',
                            value: 'MODIFIED'
                        },
                        {
                            type: 'SEQUENCE',
                            value: '7,9'
                        }
                    ]
                },
                {
                    type: 'TEXT',
                    value: 'Conditional STORE failed'
                }
            ]
        })
    );

module.exports['IMAP Parser: Partial: Start'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual((await parser('TAG1 CMD BODY[]<0>')).attributes, [
            {
                type: 'ATOM',
                value: 'BODY',
                section: [],
                partial: [0]
            }
        ])
    );

module.exports['IMAP Parser: Partial: Start.End'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual((await parser('TAG1 CMD BODY[]<12.45>')).attributes, [
            {
                type: 'ATOM',
                value: 'BODY',
                section: [],
                partial: [12, 45]
            }
        ])
    );

module.exports['IMAP Parser: Partial: Section'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual((await parser('TAG1 CMD BODY[HEADER.FIELDS (Subject From)]<12.45>')).attributes, [
            {
                type: 'ATOM',
                value: 'BODY',
                section: [
                    // keep indentation
                    {
                        type: 'ATOM',
                        value: 'HEADER.FIELDS'
                    },
                    [
                        {
                            type: 'ATOM',
                            value: 'Subject'
                        },
                        {
                            type: 'ATOM',
                            value: 'From'
                        }
                    ]
                ],
                partial: [12, 45]
            }
        ])
    );

module.exports['IMAP Parser: Partial: fail zero prefix for start'] = test => asyncWrapperFail(test, async test => test.ok(await parser('TAG1 CMD BODY[]<01>')));

module.exports['IMAP Parser: Partial: fail zero prefix for end'] = test => asyncWrapperFail(test, async test => test.ok(await parser('TAG1 CMD BODY[]<0.01>')));

module.exports['IMAP Parser: Partial: fail extra separator'] = test => asyncWrapperFail(test, async test => test.ok(await parser('TAG1 CMD BODY[]<0.1.>')));

module.exports['IMAP Parser: Sequence: mixed'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual((await parser('TAG1 CMD *:4,5:7 TEST')).attributes, [
            {
                type: 'SEQUENCE',
                value: '*:4,5:7'
            },
            {
                type: 'ATOM',
                value: 'TEST'
            }
        ])
    );

module.exports['IMAP Parser: Sequence: range'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual((await parser('TAG1 CMD 1:* TEST')).attributes, [
            {
                type: 'SEQUENCE',
                value: '1:*'
            },
            {
                type: 'ATOM',
                value: 'TEST'
            }
        ])
    );

module.exports['IMAP Parser: Sequence: limited range'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual((await parser('TAG1 CMD *:4 TEST')).attributes, [
            {
                type: 'SEQUENCE',
                value: '*:4'
            },
            {
                type: 'ATOM',
                value: 'TEST'
            }
        ])
    );

module.exports['IMAP Parser: Sequence: fail partial range'] = test => asyncWrapperFail(test, async test => test.ok(await parser('TAG1 CMD *:4,5:')));

module.exports['IMAP Parser: Sequence: fail invalid chars'] = test => asyncWrapperFail(test, async test => test.ok(await parser('TAG1 CMD *:4,5:TEST TEST')));

module.exports['IMAP Parser: Sequence: fail partial range w/ args'] = test =>
    asyncWrapperFail(test, async test => test.ok(await parser('TAG1 CMD *:4,5: TEST')));

module.exports['IMAP Parser: Sequence: fail missing colon'] = test => asyncWrapperFail(test, async test => test.ok(await parser('TAG1 CMD *4,5 TEST')));

module.exports['IMAP Parser: Sequence: fail non-range wildchar 1'] = test => asyncWrapperFail(test, async test => test.ok(await parser('TAG1 CMD *,5 TEST')));

module.exports['IMAP Parser: Sequence: fail non-range wildchar 2'] = test => asyncWrapperFail(test, async test => test.ok(await parser('TAG1 CMD 5,* TEST')));

module.exports['IMAP Parser: Sequence: failextra comma'] = test => asyncWrapperFail(test, async test => test.ok(await parser('TAG1 CMD 5, TEST')));

module.exports['IMAP Parser: escaped quotes'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual((await parser('* 331 FETCH (ENVELOPE ("=?ISO-8859-1?Q?\\"G=FCnter__Hammerl\\"?="))')).attributes, [
            {
                type: 'ATOM',
                value: 'FETCH'
            },
            [
                {
                    type: 'ATOM',
                    value: 'ENVELOPE'
                },
                [
                    {
                        type: 'STRING',
                        value: '=?ISO-8859-1?Q?"G=FCnter__Hammerl"?='
                    }
                ]
            ]
        ])
    );

module.exports['IMAP Parser: mimetorture'] = test => asyncWrapper(test, async test => test.deepEqual(await parser(mimetorture.input), mimetorture.output));

module.exports['IMAP Parser, unicode select'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual((await parser('F OK [READ-WRITE] [Gmail]/Visi laiškai selected. (Success) [THROTTLED]')).attributes, [
            {
                type: 'ATOM',
                value: '',
                section: [{ type: 'ATOM', value: 'READ-WRITE' }]
            },
            { type: 'TEXT', value: '[Gmail]/Visi laiškai selected. (Success) [THROTTLED]' }
        ])
    );

module.exports['IMAP Parser, unicode select 2'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual((await parser('E OK [READ-WRITE] [Gmail]/Вся почта selected. (Success) [THROTTLED]')).attributes, [
            {
                type: 'ATOM',
                value: '',
                section: [{ type: 'ATOM', value: 'READ-WRITE' }]
            },
            { type: 'TEXT', value: '[Gmail]/Вся почта selected. (Success) [THROTTLED]' }
        ])
    );

module.exports['IMAP Parser, single quote in atom'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual((await parser('* LIST (HasNoChildren UnMarked) "/" \'a')).attributes, [
            [
                { type: 'ATOM', value: 'HasNoChildren' },
                { type: 'ATOM', value: 'UnMarked' }
            ],
            { type: 'STRING', value: '/' },
            { type: 'ATOM', value: "'a" }
        ])
    );

module.exports['IMAP Parser, unicode status 1'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual((await parser('* STATUS Segregator/Społeczności (MESSAGES 0 UIDNEXT 1 UIDVALIDITY 1)')).attributes, [
            { type: 'ATOM', value: 'Segregator/Społeczności' },
            [
                { type: 'ATOM', value: 'MESSAGES' },
                { type: 'ATOM', value: '0' },
                { type: 'ATOM', value: 'UIDNEXT' },
                { type: 'ATOM', value: '1' },
                { type: 'ATOM', value: 'UIDVALIDITY' },
                { type: 'ATOM', value: '1' }
            ]
        ])
    );
module.exports['IMAP Parser, unicode status 12'] = test =>
    asyncWrapper(test, async test =>
        test.deepEqual((await parser('* STATUS Šegregator/Społeczności (MESSAGES 0 UIDNEXT 1 UIDVALIDITY 1)')).attributes, [
            { type: 'ATOM', value: 'Šegregator/Społeczności' },
            [
                { type: 'ATOM', value: 'MESSAGES' },
                { type: 'ATOM', value: '0' },
                { type: 'ATOM', value: 'UIDNEXT' },
                { type: 'ATOM', value: '1' },
                { type: 'ATOM', value: 'UIDVALIDITY' },
                { type: 'ATOM', value: '1' }
            ]
        ])
    );

module.exports['IMAP Parser, NO with a dot'] = test =>
    asyncWrapper(test, async test => {
        let parsed = await parser('X NO Server Unavailable. 15');
        test.equal(parsed.command, 'NO');
        test.deepEqual(parsed.attributes, [{ type: 'TEXT', value: 'Server Unavailable. 15' }]);
    });

module.exports['IMAP Parser, no tag or response (Exchange)'] = test =>
    asyncWrapper(test, async test => {
        let parsed = await parser('Server Unavailable. 15');
        test.equal(parsed.command, 'BAD');
        test.deepEqual(parsed.attributes, [{ type: 'TEXT', value: 'Server Unavailable. 15' }]);
    });

module.exports['IMAP Parser, BAD with throttling'] = test =>
    asyncWrapper(test, async test => {
        let parsed = await parser('X BAD Request is throttled. Suggested Backoff Time: 92415 milliseconds');
        test.equal(parsed.command, 'BAD');
        test.deepEqual(parsed.attributes, [{ type: 'TEXT', value: 'Request is throttled. Suggested Backoff Time: 92415 milliseconds' }]);
    });

module.exports['IMAP Parser, subfolder square bracket'] = test =>
    asyncWrapper(test, async test => {
        let parsed = await parser('* LIST (\\UnMarked) "." INBOX.[Airmail].Snooze');
        test.deepEqual(parsed.attributes, [
            [{ type: 'ATOM', value: '\\UnMarked' }],
            { type: 'STRING', value: '.' },
            { type: 'ATOM', value: 'INBOX.[Airmail].Snooze' }
        ]);
    });

module.exports['IMAP Parser, FETCH with full range'] = test =>
    asyncWrapper(test, async test => {
        let parsed = await parser('* 32 FETCH (UID 32 RFC822.SIZE 3991 BODY[2.MIME] "(* 61B literal *)" BODY[2]<0.65536> "(* 6B literal *)")');
        test.deepEqual(parsed.attributes, [
            {
                type: 'ATOM',
                value: 'FETCH'
            },
            [
                {
                    type: 'ATOM',
                    value: 'UID'
                },
                {
                    type: 'ATOM',
                    value: '32'
                },
                {
                    type: 'ATOM',
                    value: 'RFC822.SIZE'
                },
                {
                    type: 'ATOM',
                    value: '3991'
                },
                {
                    type: 'ATOM',
                    value: 'BODY',
                    section: [
                        {
                            type: 'ATOM',
                            value: '2.MIME'
                        }
                    ]
                },
                {
                    type: 'STRING',
                    value: '(* 61B literal *)'
                },
                {
                    type: 'ATOM',
                    value: 'BODY',
                    section: [
                        {
                            type: 'ATOM',
                            value: '2'
                        }
                    ],
                    partial: [0, 65536]
                },
                {
                    type: 'STRING',
                    value: '(* 6B literal *)'
                }
            ]
        ]);
    });

module.exports['IMAP Parser, FETCH with BODYSTRUCTURE'] = test =>
    asyncWrapper(test, async test => {
        let parsed = await parser(
            '* 1013 FETCH (UID 2986 MODSEQ (4960) BODYSTRUCTURE (("text" "plain" ("charset" "us-ascii") NIL NIL "7bit" 16 1 NIL NIL NIL NIL)("message" "rfc822" ("name" "Tellimuse Microsoft 365 Business Standard arve vaatamine.eml") NIL NIL "7bit" 370684 ("Mon, 16 Dec 2024 03:28:28 +0000" "Tellimuse Microsoft 365 Business Standard arve vaatamine" (("Microsoft" NIL "microsoft-noreply" "microsoft.com")) (("Microsoft" NIL "microsoft-noreply" "microsoft.com")) (("Microsoft" NIL "microsoft-noreply" "microsoft.com")) ((NIL NIL "andris.reinman" "gmail.com")) NIL NIL NIL "<58710631-775f-4c07-96ff-28a776f44d90@az.eastus2.microsoft.com>") ((("text" "plain" ("charset" "utf-8") NIL NIL "quoted-printable" 2866 80 NIL NIL NIL NIL)("text" "html" ("charset" "utf-8") NIL NIL "quoted-printable" 78392 1770 NIL NIL NIL NIL) "alternative" ("boundary" "=-EcWGOW6mwE+0T4lm385OWw==") NIL NIL NIL)("application" "octet-stream" ("name" "52482541500.pdf") NIL NIL "base64" 279430 NIL ("attachment" ("filename" "52482541500.pdf")) NIL NIL) "mixed" ("boundary" "=-1wJq2CLBJ6H+Zk2GPX9FKw==") NIL NIL NIL) 5580 NIL ("attachment" ("filename" "Tellimuse Microsoft 365 Business Standard arve vaatamine.eml")) NIL NIL) "mixed" ("boundary" "Apple-Mail=_F700EE9B-43B1-4EF1-95EE-CAA13391B333") NIL NIL NIL))'
        );

        test.deepEqual(parsed.attributes, [
            { type: 'ATOM', value: 'FETCH' },
            [
                { type: 'ATOM', value: 'UID' },
                { type: 'ATOM', value: '2986' },
                { type: 'ATOM', value: 'MODSEQ' },
                [{ type: 'ATOM', value: '4960' }],
                { type: 'ATOM', value: 'BODYSTRUCTURE' },
                [
                    [
                        { type: 'STRING', value: 'text' },
                        { type: 'STRING', value: 'plain' },
                        [
                            { type: 'STRING', value: 'charset' },
                            { type: 'STRING', value: 'us-ascii' }
                        ],
                        null,
                        null,
                        { type: 'STRING', value: '7bit' },
                        { type: 'ATOM', value: '16' },
                        { type: 'ATOM', value: '1' },
                        null,
                        null,
                        null,
                        null
                    ],
                    [
                        { type: 'STRING', value: 'message' },
                        { type: 'STRING', value: 'rfc822' },
                        [
                            { type: 'STRING', value: 'name' },
                            { type: 'STRING', value: 'Tellimuse Microsoft 365 Business Standard arve vaatamine.eml' }
                        ],
                        null,
                        null,
                        { type: 'STRING', value: '7bit' },
                        { type: 'ATOM', value: '370684' },
                        [
                            { type: 'STRING', value: 'Mon, 16 Dec 2024 03:28:28 +0000' },
                            { type: 'STRING', value: 'Tellimuse Microsoft 365 Business Standard arve vaatamine' },
                            [
                                [
                                    { type: 'STRING', value: 'Microsoft' },
                                    null,
                                    { type: 'STRING', value: 'microsoft-noreply' },
                                    { type: 'STRING', value: 'microsoft.com' }
                                ]
                            ],
                            [
                                [
                                    { type: 'STRING', value: 'Microsoft' },
                                    null,
                                    { type: 'STRING', value: 'microsoft-noreply' },
                                    { type: 'STRING', value: 'microsoft.com' }
                                ]
                            ],
                            [
                                [
                                    { type: 'STRING', value: 'Microsoft' },
                                    null,
                                    { type: 'STRING', value: 'microsoft-noreply' },
                                    { type: 'STRING', value: 'microsoft.com' }
                                ]
                            ],
                            [[null, null, { type: 'STRING', value: 'andris.reinman' }, { type: 'STRING', value: 'gmail.com' }]],
                            null,
                            null,
                            null,
                            { type: 'STRING', value: '<58710631-775f-4c07-96ff-28a776f44d90@az.eastus2.microsoft.com>' }
                        ],
                        [
                            [
                                [
                                    { type: 'STRING', value: 'text' },
                                    { type: 'STRING', value: 'plain' },
                                    [
                                        { type: 'STRING', value: 'charset' },
                                        { type: 'STRING', value: 'utf-8' }
                                    ],
                                    null,
                                    null,
                                    { type: 'STRING', value: 'quoted-printable' },
                                    { type: 'ATOM', value: '2866' },
                                    { type: 'ATOM', value: '80' },
                                    null,
                                    null,
                                    null,
                                    null
                                ],
                                [
                                    { type: 'STRING', value: 'text' },
                                    { type: 'STRING', value: 'html' },
                                    [
                                        { type: 'STRING', value: 'charset' },
                                        { type: 'STRING', value: 'utf-8' }
                                    ],
                                    null,
                                    null,
                                    { type: 'STRING', value: 'quoted-printable' },
                                    { type: 'ATOM', value: '78392' },
                                    { type: 'ATOM', value: '1770' },
                                    null,
                                    null,
                                    null,
                                    null
                                ],
                                { type: 'STRING', value: 'alternative' },
                                [
                                    { type: 'STRING', value: 'boundary' },
                                    { type: 'STRING', value: '=-EcWGOW6mwE+0T4lm385OWw==' }
                                ],
                                null,
                                null,
                                null
                            ],
                            [
                                { type: 'STRING', value: 'application' },
                                { type: 'STRING', value: 'octet-stream' },
                                [
                                    { type: 'STRING', value: 'name' },
                                    { type: 'STRING', value: '52482541500.pdf' }
                                ],
                                null,
                                null,
                                { type: 'STRING', value: 'base64' },
                                { type: 'ATOM', value: '279430' },
                                null,
                                [
                                    { type: 'STRING', value: 'attachment' },
                                    [
                                        { type: 'STRING', value: 'filename' },
                                        { type: 'STRING', value: '52482541500.pdf' }
                                    ]
                                ],
                                null,
                                null
                            ],
                            { type: 'STRING', value: 'mixed' },
                            [
                                { type: 'STRING', value: 'boundary' },
                                { type: 'STRING', value: '=-1wJq2CLBJ6H+Zk2GPX9FKw==' }
                            ],
                            null,
                            null,
                            null
                        ],
                        { type: 'ATOM', value: '5580' },
                        null,
                        [
                            { type: 'STRING', value: 'attachment' },
                            [
                                { type: 'STRING', value: 'filename' },
                                { type: 'STRING', value: 'Tellimuse Microsoft 365 Business Standard arve vaatamine.eml' }
                            ]
                        ],
                        null,
                        null
                    ],
                    { type: 'STRING', value: 'mixed' },
                    [
                        { type: 'STRING', value: 'boundary' },
                        { type: 'STRING', value: 'Apple-Mail=_F700EE9B-43B1-4EF1-95EE-CAA13391B333' }
                    ],
                    null,
                    null,
                    null
                ]
            ]
        ]);
    });

module.exports['IMAP Parser, FETCH with BODYSTRUCTURE'] = test =>
    asyncWrapper(test, async test => {
        try {
            let parsed = await parser('* 1 FETCH (UID 1 (((((((((((((((((((((((((');
            test.ok(!parsed);
        } catch (err) {
            test.ok(err);
            if (err.code !== 'MAX_IMAP_NESTING_REACHED') {
                throw err;
            }
        }
    });

module.exports['IMAP Parser, ATOM with <, [, ]'] = test =>
    asyncWrapper(test, async test => {
        let password = `<[+=</$]`;
        let parsed = await parser(`3 LOGIN user@domain ${password}`);
        test.deepEqual(parsed, {
            tag: '3',
            command: 'LOGIN',
            attributes: [
                { type: 'ATOM', value: 'user@domain' },
                { type: 'ATOM', value: password }
            ]
        });
    });
