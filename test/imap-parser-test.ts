/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parser } from '../src/handler/imap-handler.js';
import { ParserInstance } from '../src/handler/parser-instance.js';
import mimetorture from './fixtures/serialized-mimetorture.js';

// Asserts that `fn` throws (or rejects with) an error carrying the expected `code`,
// not merely that *some* error was thrown.
let expectErrorCode = (code: string, fn: () => any) => async () => {
    let err: any;
    try {
        await fn();
    } catch (e) {
        err = e;
    }
    assert.ok(err, 'expected an error to be thrown');
    assert.equal(err && err.code, code);
};

describe('imap-parser', () => {
    it('IMAP Parser: Tags: get TAG', async () => assert.equal((await parser('TAG1 CMD')).tag, 'TAG1'));
    it('IMAP Parser: Tags: space before TAG', async () => {
        await assert.rejects(async () => assert.ok(await parser(' TAG CMD')));
    });
    it('IMAP Parser: Tags: fail empty TAG', async () => {
        await assert.rejects(async () => assert.ok(await parser('')));
    });
    it('IMAP Parser: Tags: * TAG', async () => assert.equal((await parser('* CMD')).tag, '*'));
    it('IMAP Parser: Tags: + TAG', async () => assert.equal((await parser('+ CMD')).tag, '+'));
    it('IMAP Parser: Tags: fail TAG only', async () => {
        await assert.rejects(async () => assert.ok(await parser('TAG1')));
    });
    it('IMAP Parser: Tags: fail invalid char in TAG', async () => {
        await assert.rejects(async () => assert.ok(await parser('TAG"1 CMD')));
    });
    it('IMAP Parser: Command: single', async () => assert.equal((await parser('TAG1 CMD')).command, 'CMD'));
    it('IMAP Parser: Command: multi word', async () => assert.equal((await parser('TAG1 UID FETCH')).command, 'UID FETCH'));
    it('IMAP Parser: Command: fail extra ws', async () => {
        await assert.rejects(async () => assert.ok(await parser('TAG1  CMD')));
    });
    it('IMAP Parser: Command: fail empty command', async () => {
        await assert.rejects(async () => assert.ok(await parser('TAG1 ')));
    });
    it('IMAP Parser: Command: fail invalid char in command', async () => {
        await assert.rejects(async () => assert.ok(await parser('TAG1 CM=D')));
    });
    it('IMAP Parser: Args: allow trailing whitespace and empty arguments', async () =>
        assert.deepEqual(await parser('* SEARCH '), { tag: '*', command: 'SEARCH' }));
    it('IMAP Parser: Attributes: single atom', async () =>
        assert.deepEqual((await parser('TAG1 CMD FED')).attributes, [
            {
                type: 'ATOM',
                value: 'FED'
            }
        ]));
    it('IMAP Parser: Attributes: multiple atoms', async () =>
        assert.deepEqual((await parser('TAG1 CMD FED TED')).attributes, [
            {
                type: 'ATOM',
                value: 'FED'
            },
            {
                type: 'ATOM',
                value: 'TED'
            }
        ]));
    it('IMAP Parser: Attributes: special char in atom', async () =>
        assert.deepEqual((await parser('TAG1 CMD %')).attributes, [
            {
                type: 'ATOM',
                value: '%'
            }
        ]));
    it('IMAP Parser: Attributes: escaped char in atom', async () =>
        assert.deepEqual((await parser('TAG1 CMD \\*')).attributes, [
            {
                type: 'ATOM',
                value: '\\*'
            }
        ]));
    it('IMAP Parser: Attributes: sub list', async () =>
        assert.deepEqual((await parser('12.82 STATUS [Gmail].Trash (UIDNEXT UNSEEN HIGHESTMODSEQ)')).attributes, [
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
        ]));
    it('IMAP Parser: Attributes: single string', async () =>
        assert.deepEqual((await parser('TAG1 CMD "ABCDE"')).attributes, [
            {
                type: 'STRING',
                value: 'ABCDE'
            }
        ]));
    it('IMAP Parser: Attributes: multiple strings', async () =>
        assert.deepEqual((await parser('TAG1 CMD "ABCDE" "DEFGH"')).attributes, [
            {
                type: 'STRING',
                value: 'ABCDE'
            },
            {
                type: 'STRING',
                value: 'DEFGH'
            }
        ]));
    it('IMAP Parser: Attributes: invalid char in string', async () =>
        assert.deepEqual((await parser('* 1 FETCH (BODY[] "\xc2")')).attributes, [
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
        ]));
    it('IMAP Parser: Lists: single atom', async () =>
        assert.deepEqual((await parser('TAG1 CMD (1234)')).attributes, [
            [
                {
                    type: 'ATOM',
                    value: '1234'
                }
            ]
        ]));
    it('IMAP Parser: Lists: multiple atoms', async () =>
        assert.deepEqual((await parser('TAG1 CMD (1234 TERE)')).attributes, [
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
        ]));
    it('IMAP Parser: Lists: multiple lists', async () =>
        assert.deepEqual((await parser('TAG1 CMD (1234)(TERE)')).attributes, [
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
        ]));
    it('IMAP Parser: Lists: extra whitespace in start of list', async () =>
        assert.deepEqual((await parser('TAG1 CMD ( 1234)')).attributes, [
            [
                {
                    type: 'ATOM',
                    value: '1234'
                }
            ]
        ]));
    it('IMAP Parser: Lists: extra whitespace in end of list', async () =>
        assert.deepEqual((await parser('TAG1 CMD (1234 )')).attributes, [
            [
                {
                    type: 'ATOM',
                    value: '1234'
                }
            ]
        ]));
    it('IMAP Parser: Lists: extra whitespace after list', async () =>
        assert.deepEqual((await parser('TAG1 CMD (1234) ')).attributes, [
            [
                {
                    type: 'ATOM',
                    value: '1234'
                }
            ]
        ]));
    it('IMAP Parser: Lists: nested list 1', async () =>
        assert.deepEqual((await parser('TAG1 CMD (((TERE)) VANA)')).attributes, [
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
        ]));
    it('IMAP Parser: Lists: nested list 2', async () =>
        assert.deepEqual((await parser('TAG1 CMD (( (TERE)) VANA)')).attributes, [
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
        ]));
    it('IMAP Parser: Lists: nested list 3', async () =>
        assert.deepEqual((await parser('TAG1 CMD (((TERE) ) VANA)')).attributes, [
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
        ]));
    it('IMAP Parser: Literals: single literal', async () =>
        assert.deepEqual((await parser('TAG1 CMD {4}\r\n', { literals: [Buffer.from('abcd')] })).attributes, [
            {
                type: 'LITERAL',
                value: Buffer.from('abcd')
            }
        ]));
    it('IMAP Parser: Literals: literal with NULL', async () =>
        assert.deepEqual((await parser('TAG1 CMD {4}\r\n', { literals: [Buffer.from('ab\x00d')] })).attributes, [
            {
                type: 'LITERAL',
                value: Buffer.from('ab\x00d')
            }
        ]));
    it('IMAP Parser: empty continuation (+) response', async () => {
        let parsed = await parser('+');
        assert.equal(parsed.tag, '+');
        assert.equal(parsed.command, '');
    });
    it(
        'IMAP Parser: non-space after command throws ParserError5',
        expectErrorCode('ParserError5', () => parser('TAG1 CMD\tx'))
    );
    it(
        'IMAP Parser: leading whitespace in attributes throws ParserError7',
        expectErrorCode('ParserError7', () => parser('TAG1 CMD \tx'))
    );
    it(
        'IMAP Parser: getAttributes on empty input throws ParserError6',
        expectErrorCode('ParserError6', () => {
            // constructed without options to also exercise the options default branch
            let pi = new ParserInstance('');
            return pi.getAttributes();
        })
    );
    it('IMAP Parser: strips leading NUL padding and records count', async () => {
        let buf = Buffer.concat([Buffer.from([0, 0, 0]), Buffer.from('* OK ready')]);
        let parsed = await parser(buf);
        assert.equal(parsed.tag, '*');
        assert.equal(parsed.command, 'OK');
        assert.equal(parsed.nullBytesRemoved, 3);
    });
    it('IMAP Parser: all-NUL input becomes BAD response', async () => {
        let parsed = await parser(Buffer.from([0, 0, 0, 0]));
        assert.equal(parsed.tag, '*');
        assert.equal(parsed.command, 'BAD');
        assert.deepEqual(parsed.attributes, []);
    });
    it('IMAP Parser: Literals: literal8', async () =>
        assert.deepEqual((await parser('TAG1 CMD ~{4}\r\n', { literals: [Buffer.from('ab\x00d')] })).attributes, [
            {
                type: 'LITERAL',
                value: Buffer.from('ab\x00d')
            }
        ]));
    it('IMAP Parser: Literals: unexpected literal8 prefix', async () => {
        try {
            await parser('TAG1 CMD ~\r\n');
            assert.ok(false, 'Must throw');
        } catch (err) {
            assert.ok(err, 'Error must exist');
        }
    });
    it('IMAP Parser: Literals: multiple literals', async () =>
        assert.deepEqual((await parser('TAG1 CMD {4}\r\n {4}\r\n', { literals: [Buffer.from('abcd'), Buffer.from('kere')] })).attributes, [
            {
                type: 'LITERAL',
                value: Buffer.from('abcd')
            },
            {
                type: 'LITERAL',
                value: Buffer.from('kere')
            }
        ]));
    it('IMAP Parser: Literals: list', async () =>
        assert.deepEqual((await parser('TAG1 CMD ({4}\r\n {4}\r\n)', { literals: [Buffer.from('abcd'), Buffer.from('kere')] })).attributes, [
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
        ]));
    it('IMAP Parser: Tags: fail extra ws after literal', async () => {
        await assert.rejects(async () => assert.ok(await parser('TAG1 CMD {4}\r\n{4}  \r\n', { literals: [Buffer.from('abcd'), Buffer.from('kere')] })));
    });
    it('IMAP Parser: Literals: allow zero length literal in the end of a list', async () =>
        assert.deepEqual((await parser('TAG1 CMD ({0}\r\n)')).attributes, [
            [
                {
                    type: 'LITERAL',
                    value: ''
                }
            ]
        ]));
    it('IMAP Parser: Literals: zero length literal keeps the literal queue aligned', async () =>
        // ImapStream queues a Buffer for every literal marker it extracts, including
        // {0}, so the parser must consume exactly one queue entry per marker.
        // Otherwise every literal after a {0} in the same response is silently
        // shifted to the wrong value (RFC 9051 4.3 allows {0} as an empty string).
        assert.deepEqual((await parser('TAG1 CMD ({0}\r\n {5}\r\n)', { literals: [Buffer.from(''), Buffer.from('hello')] })).attributes, [
            [
                {
                    type: 'LITERAL',
                    value: Buffer.from('')
                },
                {
                    type: 'LITERAL',
                    value: Buffer.from('hello')
                }
            ]
        ]));
    it('IMAP Parser: Literals: zero length literal between literals keeps values aligned', async () =>
        assert.deepEqual(
            (await parser('TAG1 CMD ({3}\r\n {0}\r\n {5}\r\n)', { literals: [Buffer.from('abc'), Buffer.from(''), Buffer.from('world')] })).attributes,
            [
                [
                    {
                        type: 'LITERAL',
                        value: Buffer.from('abc')
                    },
                    {
                        type: 'LITERAL',
                        value: Buffer.from('')
                    },
                    {
                        type: 'LITERAL',
                        value: Buffer.from('world')
                    }
                ]
            ]
        ));

    // RFC 9051 updated resp-text to allow empty text: resp-text = ["[" resp-text-code "]" SP] [text]
    it('IMAP Parser: resp-text: bare OK with no text', async () => assert.deepEqual(await parser('* OK'), { tag: '*', command: 'OK' }));
    it('IMAP Parser: resp-text: tagged OK with no text', async () => assert.deepEqual(await parser('TAG1 OK'), { tag: 'TAG1', command: 'OK' }));
    it('IMAP Parser: resp-text: response code with no trailing text', async () => {
        let parsed = await parser('* OK [UIDNEXT 5]');
        assert.equal(parsed.command, 'OK');
        assert.deepEqual(parsed.attributes, [
            {
                type: 'ATOM',
                value: '',
                section: [
                    { type: 'ATOM', value: 'UIDNEXT' },
                    { type: 'ATOM', value: '5' }
                ]
            }
        ]);
    });
    it('IMAP Parser: resp-text: response code with trailing space and no text', async () => {
        let parsed = await parser('* OK [READ-WRITE] ');
        assert.equal(parsed.command, 'OK');
        assert.deepEqual(parsed.attributes, [
            {
                type: 'ATOM',
                value: '',
                section: [{ type: 'ATOM', value: 'READ-WRITE' }]
            }
        ]);
    });

    // RFC 9051 uses number64 (up to 2^63-1) for message and body sizes - values beyond
    // 2^32 must survive the tokenizer without truncation
    it('IMAP Parser: number64: RFC822.SIZE beyond 32 bits', async () => {
        let parsed = await parser('* 1 FETCH (RFC822.SIZE 12345678901234)');
        assert.deepEqual(parsed.attributes, [
            { type: 'ATOM', value: 'FETCH' },
            [
                { type: 'ATOM', value: 'RFC822.SIZE' },
                { type: 'ATOM', value: '12345678901234' }
            ]
        ]);
    });
    it('IMAP Parser: number64: response code argument beyond 32 bits', async () => {
        let parsed = await parser('* OK [HIGHESTMODSEQ 90060115194045007] Ok');
        assert.deepEqual(parsed.attributes, [
            {
                type: 'ATOM',
                value: '',
                section: [
                    { type: 'ATOM', value: 'HIGHESTMODSEQ' },
                    { type: 'ATOM', value: '90060115194045007' }
                ]
            },
            { type: 'TEXT', value: 'Ok' }
        ]);
    });
    it('IMAP Parser: Section: empty', async () =>
        assert.deepEqual((await parser('TAG1 CMD BODY[]')).attributes, [
            {
                type: 'ATOM',
                value: 'BODY',
                section: []
            }
        ]));
    it('IMAP Parser: Section: list', async () =>
        assert.deepEqual((await parser('TAG1 CMD BODY[(KERE)]')).attributes, [
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
        ]));
    it('IMAP Parser: Section: allow trailing ws', async () =>
        assert.deepEqual((await parser('TAG1 CMD BODY[HEADER.FIELDS (Subject From) ]')).attributes, [
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
        ]));
    it('IMAP Parser: Readable: simple', async () =>
        assert.deepEqual(await parser('* OK Hello world!'), {
            command: 'OK',
            tag: '*',
            attributes: [
                {
                    type: 'TEXT',
                    value: 'Hello world!'
                }
            ]
        }));
    it('IMAP Parser: Readable: section', async () =>
        assert.deepEqual(await parser('* OK [CAPABILITY IDLE] Hello world!'), {
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
        }));

    // USEATTR is from RFC6154; we are testing that just an ATOM
    // on its own will parse successfully here.  (All of the
    // RFC5530 codes are also single atoms.)
    it('IMAP Parser: Section: USEATTR', async () =>
        assert.deepEqual(await parser('TAG1 OK [USEATTR] \\All not supported'), {
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
        }));

    // RFC5267 defines the NOUPDATE error.  Including for quote /
    // string coverage.
    it('IMAP Parser: Section: NOUPDATE', async () =>
        assert.deepEqual(await parser('* NO [NOUPDATE "B02"] Too many contexts'), {
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
        }));

    // RFC5464 defines the METADATA response code; adding this to
    // ensure the transition for when '2199' hits ']' is handled
    // safely.
    it('IMAP Parser: Section: METADATA', async () =>
        assert.deepEqual(await parser('TAG1 OK [METADATA LONGENTRIES 2199] GETMETADATA complete'), {
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
        }));

    // RFC4467 defines URLMECH.  Included because of the example
    // third atom involves base64-encoding which is somewhat unusual
    it('IMAP Parser: Section: URLMECH', async () =>
        assert.deepEqual(await parser('TAG1 OK [URLMECH INTERNAL XSAMPLE=P34OKhO7VEkCbsiYY8rGEg==] done'), {
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
        }));

    // RFC2221 defines REFERRAL where the argument is an imapurl
    // (defined by RFC2192 which is obsoleted by RFC5092) which
    // is significantly more complicated than the rest of the IMAP
    // grammar and which was based on the RFC2060 grammar where
    // resp_text_code included:
    //   atom [SPACE 1*<any TEXT_CHAR except ']'>]
    // So this is just a test case of our explicit special-casing
    // of REFERRAL.
    it('IMAP Parser: Section: REFERRAL', async () =>
        assert.deepEqual(await parser('TAG1 NO [REFERRAL IMAP://user;AUTH=*@SERVER2/] Remote Server'), {
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
        }));

    // PERMANENTFLAGS is from RFC3501.  Its syntax is also very
    // similar to BADCHARSET, except BADCHARSET has astrings
    // inside the list.
    it('IMAP Parser: Section: PERMANENTFLAGS', async () =>
        assert.deepEqual(await parser('* OK [PERMANENTFLAGS (de:hacking $label kt-evalution [css3-page] \\*)] Flags permitted.'), {
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
        }));

    // COPYUID is from RFC4315 and included the previously failing
    // parsing situation of a sequence terminated by ']' rather than
    // whitespace.
    it('IMAP Parser: Section: COPYUID', async () =>
        assert.deepEqual(await parser('TAG1 OK [COPYUID 4 1417051618:1417051620 1421730687:1421730689] COPY completed'), {
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
        }));

    // MODIFIED is from RFC4551 and is basically the same situation
    // as the COPYUID case, but in this case our example sequences
    // have commas in them.  (Note that if there was no comma, the
    // '7,9' payload would end up an ATOM.)
    it('IMAP Parser: Section: MODIFIED', async () =>
        assert.deepEqual(await parser('TAG1 OK [MODIFIED 7,9] Conditional STORE failed'), {
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
        }));
    it('IMAP Parser: Partial: Start', async () =>
        assert.deepEqual((await parser('TAG1 CMD BODY[]<0>')).attributes, [
            {
                type: 'ATOM',
                value: 'BODY',
                section: [],
                partial: [0]
            }
        ]));
    it('IMAP Parser: Partial: Start.End', async () =>
        assert.deepEqual((await parser('TAG1 CMD BODY[]<12.45>')).attributes, [
            {
                type: 'ATOM',
                value: 'BODY',
                section: [],
                partial: [12, 45]
            }
        ]));
    it('IMAP Parser: Partial: Section', async () =>
        assert.deepEqual((await parser('TAG1 CMD BODY[HEADER.FIELDS (Subject From)]<12.45>')).attributes, [
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
        ]));
    it('IMAP Parser: Partial: fail zero prefix for start', async () => {
        await assert.rejects(async () => assert.ok(await parser('TAG1 CMD BODY[]<01>')));
    });
    it('IMAP Parser: Partial: fail zero prefix for end', async () => {
        await assert.rejects(async () => assert.ok(await parser('TAG1 CMD BODY[]<0.01>')));
    });
    it('IMAP Parser: Partial: fail extra separator', async () => {
        await assert.rejects(async () => assert.ok(await parser('TAG1 CMD BODY[]<0.1.>')));
    });
    it('IMAP Parser: Sequence: mixed', async () =>
        assert.deepEqual((await parser('TAG1 CMD *:4,5:7 TEST')).attributes, [
            {
                type: 'SEQUENCE',
                value: '*:4,5:7'
            },
            {
                type: 'ATOM',
                value: 'TEST'
            }
        ]));
    it('IMAP Parser: Sequence: range', async () =>
        assert.deepEqual((await parser('TAG1 CMD 1:* TEST')).attributes, [
            {
                type: 'SEQUENCE',
                value: '1:*'
            },
            {
                type: 'ATOM',
                value: 'TEST'
            }
        ]));
    it('IMAP Parser: Sequence: limited range', async () =>
        assert.deepEqual((await parser('TAG1 CMD *:4 TEST')).attributes, [
            {
                type: 'SEQUENCE',
                value: '*:4'
            },
            {
                type: 'ATOM',
                value: 'TEST'
            }
        ]));
    it('IMAP Parser: Sequence: fail partial range', async () => {
        await assert.rejects(async () => assert.ok(await parser('TAG1 CMD *:4,5:')));
    });
    it('IMAP Parser: Sequence: fail invalid chars', async () => {
        await assert.rejects(async () => assert.ok(await parser('TAG1 CMD *:4,5:TEST TEST')));
    });
    it('IMAP Parser: Sequence: fail partial range w/ args', async () => {
        await assert.rejects(async () => assert.ok(await parser('TAG1 CMD *:4,5: TEST')));
    });
    it('IMAP Parser: Sequence: fail missing colon', async () => {
        await assert.rejects(async () => assert.ok(await parser('TAG1 CMD *4,5 TEST')));
    });
    it('IMAP Parser: Sequence: fail non-range wildchar 1', async () => {
        await assert.rejects(async () => assert.ok(await parser('TAG1 CMD *,5 TEST')));
    });
    it('IMAP Parser: Sequence: fail non-range wildchar 2', async () => {
        await assert.rejects(async () => assert.ok(await parser('TAG1 CMD 5,* TEST')));
    });
    it('IMAP Parser: Sequence: failextra comma', async () => {
        await assert.rejects(async () => assert.ok(await parser('TAG1 CMD 5, TEST')));
    });
    it('IMAP Parser: escaped quotes', async () =>
        assert.deepEqual((await parser('* 331 FETCH (ENVELOPE ("=?ISO-8859-1?Q?\\"G=FCnter__Hammerl\\"?="))')).attributes, [
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
        ]));
    it('IMAP Parser: mimetorture', async () => assert.deepEqual(await parser(mimetorture.input), mimetorture.output));
    it('IMAP Parser, unicode select', async () =>
        assert.deepEqual((await parser('F OK [READ-WRITE] [Gmail]/Visi laiškai selected. (Success) [THROTTLED]')).attributes, [
            {
                type: 'ATOM',
                value: '',
                section: [{ type: 'ATOM', value: 'READ-WRITE' }]
            },
            { type: 'TEXT', value: '[Gmail]/Visi laiškai selected. (Success) [THROTTLED]' }
        ]));
    it('IMAP Parser, unicode select 2', async () =>
        assert.deepEqual((await parser('E OK [READ-WRITE] [Gmail]/Вся почта selected. (Success) [THROTTLED]')).attributes, [
            {
                type: 'ATOM',
                value: '',
                section: [{ type: 'ATOM', value: 'READ-WRITE' }]
            },
            { type: 'TEXT', value: '[Gmail]/Вся почта selected. (Success) [THROTTLED]' }
        ]));
    it('IMAP Parser, single quote in atom', async () =>
        assert.deepEqual((await parser('* LIST (HasNoChildren UnMarked) "/" \'a')).attributes, [
            [
                { type: 'ATOM', value: 'HasNoChildren' },
                { type: 'ATOM', value: 'UnMarked' }
            ],
            { type: 'STRING', value: '/' },
            { type: 'ATOM', value: "'a" }
        ]));
    it('IMAP Parser, unicode status 1', async () =>
        assert.deepEqual((await parser('* STATUS Segregator/Społeczności (MESSAGES 0 UIDNEXT 1 UIDVALIDITY 1)')).attributes, [
            { type: 'ATOM', value: 'Segregator/Społeczności' },
            [
                { type: 'ATOM', value: 'MESSAGES' },
                { type: 'ATOM', value: '0' },
                { type: 'ATOM', value: 'UIDNEXT' },
                { type: 'ATOM', value: '1' },
                { type: 'ATOM', value: 'UIDVALIDITY' },
                { type: 'ATOM', value: '1' }
            ]
        ]));
    it('IMAP Parser, unicode status 12', async () =>
        assert.deepEqual((await parser('* STATUS Šegregator/Społeczności (MESSAGES 0 UIDNEXT 1 UIDVALIDITY 1)')).attributes, [
            { type: 'ATOM', value: 'Šegregator/Społeczności' },
            [
                { type: 'ATOM', value: 'MESSAGES' },
                { type: 'ATOM', value: '0' },
                { type: 'ATOM', value: 'UIDNEXT' },
                { type: 'ATOM', value: '1' },
                { type: 'ATOM', value: 'UIDVALIDITY' },
                { type: 'ATOM', value: '1' }
            ]
        ]));
    it('IMAP Parser, NO with a dot', async () => {
        let parsed = await parser('X NO Server Unavailable. 15');
        assert.equal(parsed.command, 'NO');
        assert.deepEqual(parsed.attributes, [{ type: 'TEXT', value: 'Server Unavailable. 15' }]);
    });
    it('IMAP Parser, no tag or response (Exchange)', async () => {
        let parsed = await parser('Server Unavailable. 15');
        assert.equal(parsed.command, 'BAD');
        assert.deepEqual(parsed.attributes, [{ type: 'TEXT', value: 'Server Unavailable. 15' }]);
    });
    it('IMAP Parser, BAD with throttling', async () => {
        let parsed = await parser('X BAD Request is throttled. Suggested Backoff Time: 92415 milliseconds');
        assert.equal(parsed.command, 'BAD');
        assert.deepEqual(parsed.attributes, [{ type: 'TEXT', value: 'Request is throttled. Suggested Backoff Time: 92415 milliseconds' }]);
    });
    it('IMAP Parser, subfolder square bracket', async () => {
        let parsed = await parser('* LIST (\\UnMarked) "." INBOX.[Airmail].Snooze');
        assert.deepEqual(parsed.attributes, [
            [{ type: 'ATOM', value: '\\UnMarked' }],
            { type: 'STRING', value: '.' },
            { type: 'ATOM', value: 'INBOX.[Airmail].Snooze' }
        ]);
    });
    it('IMAP Parser, FETCH with full range', async () => {
        let parsed = await parser('* 32 FETCH (UID 32 RFC822.SIZE 3991 BODY[2.MIME] "(* 61B literal *)" BODY[2]<0.65536> "(* 6B literal *)")');
        assert.deepEqual(parsed.attributes, [
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
    it('IMAP Parser, FETCH with BODYSTRUCTURE', async () => {
        let parsed = await parser(
            '* 1013 FETCH (UID 2986 MODSEQ (4960) BODYSTRUCTURE (("text" "plain" ("charset" "us-ascii") NIL NIL "7bit" 16 1 NIL NIL NIL NIL)("message" "rfc822" ("name" "Tellimuse Microsoft 365 Business Standard arve vaatamine.eml") NIL NIL "7bit" 370684 ("Mon, 16 Dec 2024 03:28:28 +0000" "Tellimuse Microsoft 365 Business Standard arve vaatamine" (("Microsoft" NIL "microsoft-noreply" "microsoft.com")) (("Microsoft" NIL "microsoft-noreply" "microsoft.com")) (("Microsoft" NIL "microsoft-noreply" "microsoft.com")) ((NIL NIL "andris.reinman" "gmail.com")) NIL NIL NIL "<58710631-775f-4c07-96ff-28a776f44d90@az.eastus2.microsoft.com>") ((("text" "plain" ("charset" "utf-8") NIL NIL "quoted-printable" 2866 80 NIL NIL NIL NIL)("text" "html" ("charset" "utf-8") NIL NIL "quoted-printable" 78392 1770 NIL NIL NIL NIL) "alternative" ("boundary" "=-EcWGOW6mwE+0T4lm385OWw==") NIL NIL NIL)("application" "octet-stream" ("name" "52482541500.pdf") NIL NIL "base64" 279430 NIL ("attachment" ("filename" "52482541500.pdf")) NIL NIL) "mixed" ("boundary" "=-1wJq2CLBJ6H+Zk2GPX9FKw==") NIL NIL NIL) 5580 NIL ("attachment" ("filename" "Tellimuse Microsoft 365 Business Standard arve vaatamine.eml")) NIL NIL) "mixed" ("boundary" "Apple-Mail=_F700EE9B-43B1-4EF1-95EE-CAA13391B333") NIL NIL NIL))'
        );

        assert.deepEqual(parsed.attributes, [
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

    // NB! must not share a name with the deep-BODYSTRUCTURE test above - a duplicate
    // module.exports key silently overwrites the earlier test and it never runs
    it('IMAP Parser, FETCH exceeding max nesting depth', async () => {
        try {
            let parsed = await parser('* 1 FETCH (UID 1 (((((((((((((((((((((((((');
            assert.ok(!parsed);
        } catch (err: any) {
            assert.ok(err);
            if (err.code !== 'MAX_IMAP_NESTING_REACHED') {
                throw err;
            }
        }
    });
    it('IMAP Parser, ATOM with <, [, ]', async () => {
        let password = `<[+=</$]`;
        let parsed = await parser(`3 LOGIN user@domain ${password}`);
        assert.deepEqual(parsed, {
            tag: '3',
            command: 'LOGIN',
            attributes: [
                { type: 'ATOM', value: 'user@domain' },
                { type: 'ATOM', value: password }
            ]
        });
    });
    it('IMAP Parser: unbalanced bracket in a response code keeps the human-readable text', async () => {
        // RFC 9051 lets a response code carry free text containing '[' but not ']'.
        // Counting that '[' as a nested bracket loses the whole human-readable text,
        // which is what NO/BAD error messages are built from.
        const parsed = await parser('A1 NO [XFOO see bar[baz] mailbox is busy');
        const text = (parsed.attributes || [])
            .filter(entry => entry && entry.type === 'TEXT')
            .map(entry => entry!.value)
            .join('');
        assert.equal(text, 'mailbox is busy');
    });
    it('IMAP Parser: balanced brackets inside a response code are still tolerated', async () => {
        // Servers do put bracketed values inside a code, so a plain first-']' scan
        // would cut the code in half
        const parsed: any = await parser('* OK [PERMANENTFLAGS ([css3-page] \\*)] Flags permitted.');
        const text = (parsed.attributes || [])
            .filter((entry: any) => entry && entry.type === 'TEXT')
            .map((entry: any) => entry!.value)
            .join('');
        assert.equal(text, 'Flags permitted.');
        assert.equal(parsed.attributes[0].section[0].value, 'PERMANENTFLAGS');
    });
    it('IMAP Parser: a parse failure after the tag exposes the parsed tag', async () => {
        // The connection settles the in-flight command from an unparseable tagged
        // completion using this tag - re-deriving it from the raw bytes instead would
        // bypass the leading-NUL workaround and strand the command
        let err: any = null;
        try {
            await parser(Buffer.from('A5 OK [\x01BAD-CODE] done', 'binary'));
        } catch (e) {
            err = e;
        }
        assert.ok(err, 'the line must fail to parse');
        assert.equal(err && err.parsedTag, 'A5');

        // The NUL-padding workaround is inherited: the exposed tag is the stripped one
        err = null;
        try {
            await parser(Buffer.from('\x00\x00A6 OK [\x01BAD-CODE] done', 'binary'));
        } catch (e) {
            err = e;
        }
        assert.ok(err, 'the padded line must fail to parse');
        assert.equal(err && (err as any).parsedTag, 'A6');
    });
});
