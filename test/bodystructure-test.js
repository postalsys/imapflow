'use strict';

const { parseBodystructure } = require('../lib/tools');

module.exports['Process correct TEXT with line count'] = test => {
    let attribute = [
        [
            [
                {
                    type: 'STRING',
                    value: 'text'
                },
                {
                    type: 'STRING',
                    value: 'plain'
                },
                [
                    {
                        type: 'STRING',
                        value: 'charset'
                    },
                    {
                        type: 'STRING',
                        value: 'UTF-8'
                    }
                ],
                null,
                null,
                {
                    type: 'STRING',
                    value: '7bit'
                },
                {
                    type: 'ATOM',
                    value: '23'
                },
                {
                    type: 'ATOM',
                    value: '1'
                },
                null,
                null,
                null,
                null
            ],
            [
                {
                    type: 'STRING',
                    value: 'text'
                },
                {
                    type: 'STRING',
                    value: 'html'
                },
                [
                    {
                        type: 'STRING',
                        value: 'charset'
                    },
                    {
                        type: 'STRING',
                        value: 'UTF-8'
                    }
                ],
                null,
                null,
                {
                    type: 'STRING',
                    value: '7bit'
                },
                {
                    type: 'ATOM',
                    value: '49'
                },
                {
                    type: 'ATOM',
                    value: '1'
                },
                null,
                null,
                null,
                null
            ],
            {
                type: 'STRING',
                value: 'alternative'
            },
            [
                {
                    type: 'STRING',
                    value: 'boundary'
                },
                {
                    type: 'STRING',
                    value: '000000000000b56402062b1fba83'
                }
            ],
            null,
            null,
            null
        ],
        [
            {
                type: 'STRING',
                value: 'text'
            },
            {
                type: 'STRING',
                value: 'plain'
            },
            [
                {
                    type: 'STRING',
                    value: 'charset'
                },
                {
                    type: 'STRING',
                    value: 'US-ASCII'
                },
                {
                    type: 'STRING',
                    value: 'name'
                },
                {
                    type: 'STRING',
                    value: 'log_imap_missing_attachments.txt'
                }
            ],
            {
                type: 'STRING',
                value: '<f_m5mnf91y1>'
            },
            null,
            {
                type: 'STRING',
                value: 'base64'
            },
            {
                type: 'ATOM',
                value: '33954'
            },
            {
                type: 'ATOM',
                value: '435'
            },
            null,
            [
                {
                    type: 'STRING',
                    value: 'attachment'
                },
                [
                    {
                        type: 'STRING',
                        value: 'filename'
                    },
                    {
                        type: 'STRING',
                        value: 'log_imap_missing_attachments.txt'
                    }
                ]
            ],
            null,
            null
        ],
        [
            {
                type: 'STRING',
                value: 'image'
            },
            {
                type: 'STRING',
                value: 'jpeg'
            },
            [
                {
                    type: 'STRING',
                    value: 'name'
                },
                {
                    type: 'STRING',
                    value: 'img2.jpeg'
                }
            ],
            {
                type: 'STRING',
                value: '<f_m5mnf4c70>'
            },
            null,
            {
                type: 'STRING',
                value: 'base64'
            },
            {
                type: 'ATOM',
                value: '3776960'
            },
            null,
            [
                {
                    type: 'STRING',
                    value: 'attachment'
                },
                [
                    {
                        type: 'STRING',
                        value: 'filename'
                    },
                    {
                        type: 'STRING',
                        value: 'img2.jpeg'
                    }
                ]
            ],
            null,
            null
        ],
        {
            type: 'STRING',
            value: 'mixed'
        },
        [
            {
                type: 'STRING',
                value: 'boundary'
            },
            {
                type: 'STRING',
                value: '000000000000b56402062b1fba85'
            }
        ],
        null,
        null,
        null
    ];

    attribute = [
        [
            [
                {
                    type: 'STRING',
                    value: 'text'
                },
                {
                    type: 'STRING',
                    value: 'plain'
                },
                [
                    {
                        type: 'STRING',
                        value: 'charset'
                    },
                    {
                        type: 'STRING',
                        value: 'UTF-8'
                    }
                ],
                null,
                null,
                {
                    type: 'STRING',
                    value: '7bit'
                },
                {
                    type: 'ATOM',
                    value: '23'
                },
                {
                    type: 'ATOM',
                    value: '1'
                },
                null,
                null,
                null,
                null
            ],
            [
                {
                    type: 'STRING',
                    value: 'text'
                },
                {
                    type: 'STRING',
                    value: 'html'
                },
                [
                    {
                        type: 'STRING',
                        value: 'charset'
                    },
                    {
                        type: 'STRING',
                        value: 'UTF-8'
                    }
                ],
                null,
                null,
                {
                    type: 'STRING',
                    value: '7bit'
                },
                {
                    type: 'ATOM',
                    value: '49'
                },
                {
                    type: 'ATOM',
                    value: '1'
                },
                null,
                null,
                null,
                null
            ],
            {
                type: 'STRING',
                value: 'alternative'
            },
            [
                {
                    type: 'STRING',
                    value: 'boundary'
                },
                {
                    type: 'STRING',
                    value: '000000000000b56402062b1fba83'
                }
            ],
            null,
            null,
            null
        ],
        [
            {
                type: 'STRING',
                value: 'text'
            },
            {
                type: 'STRING',
                value: 'plain'
            },
            [
                {
                    type: 'STRING',
                    value: 'charset'
                },
                {
                    type: 'STRING',
                    value: 'US-ASCII'
                },
                {
                    type: 'STRING',
                    value: 'name'
                },
                {
                    type: 'STRING',
                    value: 'log_imap_missing_attachments.txt'
                }
            ],
            {
                type: 'STRING',
                value: '<f_m5mnf91y1>'
            },
            null,
            {
                type: 'STRING',
                value: 'base64'
            },
            {
                type: 'ATOM',
                value: '33954'
            },
            {
                type: 'ATOM',
                value: '435'
            },
            null,
            [
                {
                    type: 'STRING',
                    value: 'attachment'
                },
                [
                    {
                        type: 'STRING',
                        value: 'filename'
                    },
                    {
                        type: 'STRING',
                        value: 'log_imap_missing_attachments.txt'
                    }
                ]
            ],
            null,
            null
        ],
        [
            {
                type: 'STRING',
                value: 'image'
            },
            {
                type: 'STRING',
                value: 'jpeg'
            },
            [
                {
                    type: 'STRING',
                    value: 'name'
                },
                {
                    type: 'STRING',
                    value: 'img2.jpeg'
                }
            ],
            {
                type: 'STRING',
                value: '<f_m5mnf4c70>'
            },
            null,
            {
                type: 'STRING',
                value: 'base64'
            },
            {
                type: 'ATOM',
                value: '3776960'
            },
            null,
            [
                {
                    type: 'STRING',
                    value: 'attachment'
                },
                [
                    {
                        type: 'STRING',
                        value: 'filename'
                    },
                    {
                        type: 'STRING',
                        value: 'img2.jpeg'
                    }
                ]
            ],
            null,
            null
        ],
        {
            type: 'STRING',
            value: 'mixed'
        },
        [
            {
                type: 'STRING',
                value: 'boundary'
            },
            {
                type: 'STRING',
                value: '000000000000b56402062b1fba85'
            }
        ],
        null,
        null,
        null
    ];

    let bodyStruct = parseBodystructure(attribute);

    test.deepEqual(bodyStruct, {
        childNodes: [
            {
                part: '1',
                childNodes: [
                    {
                        part: '1.1',
                        type: 'text/plain',
                        parameters: {
                            charset: 'UTF-8'
                        },
                        encoding: '7bit',
                        size: 23,
                        lineCount: 1
                    },
                    {
                        part: '1.2',
                        type: 'text/html',
                        parameters: {
                            charset: 'UTF-8'
                        },
                        encoding: '7bit',
                        size: 49,
                        lineCount: 1
                    }
                ],
                type: 'multipart/alternative',
                parameters: {
                    boundary: '000000000000b56402062b1fba83'
                }
            },
            {
                part: '2',
                type: 'text/plain',
                parameters: {
                    charset: 'US-ASCII',
                    name: 'log_imap_missing_attachments.txt'
                },
                id: '<f_m5mnf91y1>',
                encoding: 'base64',
                size: 33954,
                lineCount: 435,
                disposition: 'attachment',
                dispositionParameters: {
                    filename: 'log_imap_missing_attachments.txt'
                }
            },
            {
                part: '3',
                type: 'image/jpeg',
                parameters: {
                    name: 'img2.jpeg'
                },
                id: '<f_m5mnf4c70>',
                encoding: 'base64',
                size: 3776960,
                disposition: 'attachment',
                dispositionParameters: {
                    filename: 'img2.jpeg'
                }
            }
        ],
        type: 'multipart/mixed',
        parameters: {
            boundary: '000000000000b56402062b1fba85'
        }
    });
    test.done();
};

module.exports['Process invalid TEXT without line count'] = test => {
    let attribute = [
        [
            [
                {
                    type: 'STRING',
                    value: 'TEXT'
                },
                {
                    type: 'STRING',
                    value: 'PLAIN'
                },
                [
                    {
                        type: 'STRING',
                        value: 'CHARSET'
                    },
                    {
                        type: 'STRING',
                        value: 'UTF-8'
                    }
                ],
                null,
                null,
                {
                    type: 'STRING',
                    value: '7bit'
                },
                {
                    type: 'ATOM',
                    value: '2'
                },
                null,
                null,
                null,
                null,
                null
            ],
            [
                {
                    type: 'STRING',
                    value: 'TEXT'
                },
                {
                    type: 'STRING',
                    value: 'HTML'
                },
                [
                    {
                        type: 'STRING',
                        value: 'CHARSET'
                    },
                    {
                        type: 'STRING',
                        value: 'UTF-8'
                    }
                ],
                null,
                null,
                {
                    type: 'STRING',
                    value: '7bit'
                },
                {
                    type: 'ATOM',
                    value: '27'
                },
                null,
                null,
                null,
                null,
                null
            ],
            {
                type: 'STRING',
                value: 'ALTERNATIVE'
            },
            [
                {
                    type: 'ATOM',
                    value: 'BOUNDARY'
                },
                {
                    type: 'STRING',
                    value: '-=Part.1=-'
                }
            ],
            null,
            null,
            null
        ],
        [
            {
                type: 'STRING',
                value: 'TEXT'
            },
            {
                type: 'STRING',
                value: 'PLAIN'
            },
            [
                {
                    type: 'STRING',
                    value: 'CHARSET'
                },
                {
                    type: 'STRING',
                    value: 'US-ASCII'
                }
            ],
            {
                type: 'STRING',
                value: '<f_m5mjjzj32>'
            },
            null,
            {
                type: 'STRING',
                value: 'base64'
            },
            {
                type: 'ATOM',
                value: '49'
            },
            null,
            [
                {
                    type: 'STRING',
                    value: 'ATTACHMENT'
                },
                [
                    {
                        type: 'STRING',
                        value: 'FILENAME'
                    },
                    {
                        type: 'STRING',
                        value: 'logs.txt'
                    }
                ]
            ],
            null,
            null
        ],
        [
            {
                type: 'STRING',
                value: 'TEXT'
            },
            {
                type: 'STRING',
                value: 'HTML'
            },
            [
                {
                    type: 'STRING',
                    value: 'CHARSET'
                },
                {
                    type: 'STRING',
                    value: 'US-ASCII'
                }
            ],
            {
                type: 'STRING',
                value: '<f_m5mjjziw1>'
            },
            null,
            {
                type: 'STRING',
                value: 'base64'
            },
            {
                type: 'ATOM',
                value: '4437'
            },
            null,
            [
                {
                    type: 'STRING',
                    value: 'ATTACHMENT'
                },
                [
                    {
                        type: 'STRING',
                        value: 'FILENAME'
                    },
                    {
                        type: 'STRING',
                        value: 'TITI.html'
                    }
                ]
            ],
            null,
            null
        ],
        [
            {
                type: 'STRING',
                value: 'IMAGE'
            },
            {
                type: 'STRING',
                value: 'PNG'
            },
            null,
            {
                type: 'STRING',
                value: '<f_m5mjjzih0>'
            },
            null,
            {
                type: 'STRING',
                value: 'base64'
            },
            {
                type: 'ATOM',
                value: '32085'
            },
            null,
            [
                {
                    type: 'STRING',
                    value: 'ATTACHMENT'
                },
                [
                    {
                        type: 'STRING',
                        value: 'FILENAME'
                    },
                    {
                        type: 'STRING',
                        value: 'Logo-google-icon-PNG.png'
                    }
                ]
            ],
            null,
            null
        ],
        [
            {
                type: 'STRING',
                value: 'APPLICATION'
            },
            {
                type: 'STRING',
                value: 'OCTET-STREAM'
            },
            null,
            {
                type: 'STRING',
                value: '<f_m5mjjzjb3>'
            },
            null,
            {
                type: 'STRING',
                value: 'base64'
            },
            {
                type: 'ATOM',
                value: '354150'
            },
            null,
            [
                {
                    type: 'STRING',
                    value: 'ATTACHMENT'
                },
                [
                    {
                        type: 'STRING',
                        value: 'FILENAME'
                    },
                    {
                        type: 'STRING',
                        value: 'logs_not_txt'
                    }
                ]
            ],
            null,
            null
        ],
        [
            {
                type: 'STRING',
                value: 'TEXT'
            },
            {
                type: 'STRING',
                value: 'MARKDOWN'
            },
            [
                {
                    type: 'STRING',
                    value: 'CHARSET'
                },
                {
                    type: 'STRING',
                    value: 'UTF-8'
                }
            ],
            {
                type: 'STRING',
                value: '<f_m5mjk5le4>'
            },
            null,
            {
                type: 'STRING',
                value: 'base64'
            },
            {
                type: 'ATOM',
                value: '21064'
            },
            null,
            [
                {
                    type: 'STRING',
                    value: 'ATTACHMENT'
                },
                [
                    {
                        type: 'STRING',
                        value: 'FILENAME'
                    },
                    {
                        type: 'STRING',
                        value: 'README.md'
                    }
                ]
            ],
            null,
            null
        ],
        {
            type: 'STRING',
            value: 'MIXED'
        },
        [
            {
                type: 'ATOM',
                value: 'BOUNDARY'
            },
            {
                type: 'STRING',
                value: '-=Part.TEXT=-'
            }
        ],
        null,
        null,
        null
    ];

    let bodyStruct = parseBodystructure(attribute);

    test.deepEqual(bodyStruct, {
        childNodes: [
            {
                part: '1',
                childNodes: [
                    {
                        part: '1.1',
                        type: 'text/plain',
                        parameters: {
                            charset: 'UTF-8'
                        },
                        encoding: '7bit',
                        size: 2
                    },
                    {
                        part: '1.2',
                        type: 'text/html',
                        parameters: {
                            charset: 'UTF-8'
                        },
                        encoding: '7bit',
                        size: 27
                    }
                ],
                type: 'multipart/alternative',
                parameters: {
                    boundary: '-=Part.1=-'
                }
            },
            {
                part: '2',
                type: 'text/plain',
                parameters: {
                    charset: 'US-ASCII'
                },
                id: '<f_m5mjjzj32>',
                encoding: 'base64',
                size: 49,
                disposition: 'attachment',
                dispositionParameters: {
                    filename: 'logs.txt'
                }
            },
            {
                part: '3',
                type: 'text/html',
                parameters: {
                    charset: 'US-ASCII'
                },
                id: '<f_m5mjjziw1>',
                encoding: 'base64',
                size: 4437,
                disposition: 'attachment',
                dispositionParameters: {
                    filename: 'TITI.html'
                }
            },
            {
                part: '4',
                type: 'image/png',
                id: '<f_m5mjjzih0>',
                encoding: 'base64',
                size: 32085,
                disposition: 'attachment',
                dispositionParameters: {
                    filename: 'Logo-google-icon-PNG.png'
                }
            },
            {
                part: '5',
                type: 'application/octet-stream',
                id: '<f_m5mjjzjb3>',
                encoding: 'base64',
                size: 354150,
                disposition: 'attachment',
                dispositionParameters: {
                    filename: 'logs_not_txt'
                }
            },
            {
                part: '6',
                type: 'text/markdown',
                parameters: {
                    charset: 'UTF-8'
                },
                id: '<f_m5mjk5le4>',
                encoding: 'base64',
                size: 21064,
                disposition: 'attachment',
                dispositionParameters: {
                    filename: 'README.md'
                }
            }
        ],
        type: 'multipart/mixed',
        parameters: {
            boundary: '-=Part.TEXT=-'
        }
    });
    test.done();
};

module.exports['Process non-standard unicode filename property'] = test => {
    let attribute = [
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
                { type: 'ATOM', value: '275385' },
                { type: 'ATOM', value: '3531' },
                null,
                null,
                null,
                null
            ],
            [
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
                    { type: 'ATOM', value: '333' },
                    { type: 'ATOM', value: '6' },
                    null,
                    null,
                    null,
                    null
                ],
                [
                    { type: 'STRING', value: 'image' },
                    { type: 'STRING', value: 'png' },
                    [
                        { type: 'STRING', value: 'name' },
                        { type: 'STRING', value: 'image-1.png' }
                    ],
                    {
                        type: 'STRING',
                        value: '<7e1703a0-b8b7-4d00-9193-989506afb76e@emailengine>'
                    },
                    null,
                    { type: 'STRING', value: 'base64' },
                    { type: 'ATOM', value: '271540' },
                    null,
                    [
                        { type: 'STRING', value: 'inline' },
                        [
                            { type: 'STRING', value: 'filename' },
                            { type: 'STRING', value: 'image-1.png' }
                        ]
                    ],
                    null,
                    null
                ],
                { type: 'STRING', value: 'related' },
                [
                    { type: 'STRING', value: 'type' },
                    { type: 'STRING', value: 'text/html' },
                    { type: 'STRING', value: 'boundary' },
                    {
                        type: 'STRING',
                        value: '----=_Part-GUieKCU_ZWVAMi40OS43_nvE0TCtGsQo-Part_4'
                    }
                ],
                null,
                null
            ],
            { type: 'STRING', value: 'alternative' },
            [
                { type: 'STRING', value: 'boundary' },
                {
                    type: 'STRING',
                    value: '----=_Part-GUieKCU_ZWVAMi40OS43_nvE0TCtGsQo-Part_2'
                }
            ],
            null,
            null
        ],
        [
            { type: 'STRING', value: 'application' },
            {
                type: 'STRING',
                value: 'vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            },
            [
                { type: 'STRING', value: 'name' },
                {
                    type: 'STRING',
                    value: '=?UTF-8?Q?Trang=5Fghi=5F=C3=A2m_=288=29_=281=29=2E?= =?UTF-8?Q?xlsx?='
                }
            ],
            null,
            null,
            { type: 'STRING', value: 'base64' },
            { type: 'ATOM', value: '532006' },
            null,
            [
                { type: 'STRING', value: 'attachment' },
                [
                    { type: 'STRING', value: 'filename' },
                    {
                        type: 'STRING',
                        value: "utf-8''Trang_ghi_%C3%A2m%20%288%29%20%281%29.xlsx"
                    }
                ]
            ],
            null,
            null
        ],
        { type: 'STRING', value: 'mixed' },
        [
            { type: 'STRING', value: 'boundary' },
            {
                type: 'STRING',
                value: '----=_Part-GUieKCU_ZWVAMi40OS43_nvE0TCtGsQo-Part_1'
            }
        ],
        null,
        null
    ];

    let bodyStruct = parseBodystructure(attribute);

    test.deepEqual(bodyStruct.childNodes[1].dispositionParameters.filename, 'Trang_ghi_âm (8) (1).xlsx');
    test.done();
};
