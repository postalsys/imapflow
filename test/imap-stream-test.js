/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

'use strict';

const { ImapStream } = require('../lib/handler/imap-stream');
const { parser } = require('../lib/handler/imap-handler');

module.exports['Full input'] = test => {
    let input = Buffer.from(
        `A CAPABILITY
A LOGIN "aaa" "bbb"
A APPEND INBOX {5}
12345
A LOGIN {5}
12345 {11}
12345678901 "another"
A LOGOUT
`.replace(/\r?\n/g, '\r\n')
    );

    let expecting = [
        { command: 'A CAPABILITY', literals: [] },
        { command: 'A LOGIN "aaa" "bbb"', literals: [] },
        { command: 'A APPEND INBOX {5}\r\n', literals: ['12345'] },
        { command: 'A LOGIN {5}\r\n {11}\r\n "another"', literals: ['12345', '12345678901'] },
        { command: 'A LOGOUT', literals: [] }
    ];

    let stream = new ImapStream();

    let reading = false;
    let reader = async () => {
        let cmd;
        while ((cmd = stream.read()) !== null) {
            test.deepEqual({ command: cmd.payload.toString(), literals: cmd.literals.map(literal => literal.toString()) }, expecting.shift());

            let parsed = await parser(cmd.payload, { literals: cmd.literals });
            console.log(parsed);
            cmd.next();
        }
    };

    stream.on('readable', () => {
        if (!reading) {
            reading = true;
            reader()
                .catch(err => console.error(err))
                .finally(() => {
                    reading = false;
                });
        }
    });

    stream.on('error', err => {
        test.ifError(err);
    });

    stream.on('end', () => {
        test.done();
    });

    let writer = async () => {
        stream.end(input);
    };

    writer().catch(err => test.ifError(err));
};

module.exports['Literal8 marker activates literal extraction'] = test => {
    // RFC 9051 folds the FETCH side of BINARY into base IMAP4rev2 - servers answer
    // BINARY fetches with literal8 syntax (~{n}) whose content may contain NULs.
    // The stream must treat the trailing {n} as a literal marker regardless of the
    // '~' prefix and hand the raw bytes over unmodified.
    let input = Buffer.from('* 1 FETCH (BINARY[1] ~{5}\r\nhel\x00o)\r\n', 'binary');

    let stream = new ImapStream();

    let reading = false;
    let reader = async () => {
        let cmd;
        while ((cmd = stream.read()) !== null) {
            test.equal(cmd.payload.toString('binary'), '* 1 FETCH (BINARY[1] ~{5}\r\n)');
            test.equal(cmd.literals.length, 1);
            test.deepEqual(cmd.literals[0], Buffer.from('hel\x00o', 'binary'));

            // and the parser consumes the literal8 into a LITERAL node with the NUL intact
            let parsed = await parser(cmd.payload, { literals: cmd.literals });
            test.deepEqual(parsed.attributes[1][1], { type: 'LITERAL', value: Buffer.from('hel\x00o', 'binary') });
            cmd.next();
        }
    };

    stream.on('readable', () => {
        if (!reading) {
            reading = true;
            reader()
                .catch(err => test.ifError(err))
                .finally(() => {
                    reading = false;
                });
        }
    });

    stream.on('error', err => {
        test.ifError(err);
    });

    stream.on('end', () => {
        test.done();
    });

    stream.end(input);
};

module.exports['Single byte'] = test => {
    let input = Buffer.from(
        `A CAPABILITY
A LOGIN "aaa" "bbb"
A APPEND INBOX {5}
12345
A LOGIN {5}
12345 {11}
12345678901 "another"
A LOGOUT
`.replace(/\r?\n/g, '\r\n')
    );

    let expecting = [
        { command: 'A CAPABILITY', literals: [] },
        { command: 'A LOGIN "aaa" "bbb"', literals: [] },
        { command: 'A APPEND INBOX {5}\r\n', literals: ['12345'] },
        { command: 'A LOGIN {5}\r\n {11}\r\n "another"', literals: ['12345', '12345678901'] },
        { command: 'A LOGOUT', literals: [] }
    ];

    let stream = new ImapStream();

    let reading = false;
    let reader = async () => {
        let cmd;
        while ((cmd = stream.read()) !== null) {
            test.deepEqual({ command: cmd.payload.toString(), literals: cmd.literals.map(literal => literal.toString()) }, expecting.shift());
            cmd.next();
        }
    };

    stream.on('readable', () => {
        if (!reading) {
            reading = true;
            reader()
                .catch(err => console.error(err))
                .finally(() => {
                    reading = false;
                });
        }
    });

    stream.on('error', err => {
        test.ifError(err);
    });

    stream.on('end', () => {
        test.done();
    });

    let writer = async () => {
        for (let i = 0; i < input.length; i++) {
            if (stream.write(Buffer.from([input[i]])) === false) {
                await new Promise(resolve => stream.once('drain', resolve));
            }
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        stream.end();
    };

    writer().catch(err => test.ifError(err));
};
