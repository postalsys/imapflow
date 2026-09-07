/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ImapStream } from '../src/handler/imap-stream.js';
import { parser } from '../src/handler/imap-handler.js';

describe('imap-stream', () => {
    it('Full input', (t, done) => {
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
                assert.deepEqual({ command: cmd.payload.toString(), literals: cmd.literals.map((literal: any) => literal.toString()) }, expecting.shift());

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
            assert.ifError(err);
        });

        stream.on('end', () => {
            done();
        });

        let writer = async () => {
            stream.end(input);
        };

        writer().catch(err => assert.ifError(err));
    });
    it('Literal8 marker activates literal extraction', (t, done) => {
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
                assert.equal(cmd.payload.toString('binary'), '* 1 FETCH (BINARY[1] ~{5}\r\n)');
                assert.equal(cmd.literals.length, 1);
                assert.deepEqual(cmd.literals[0], Buffer.from('hel\x00o', 'binary'));

                // and the parser consumes the literal8 into a LITERAL node with the NUL intact
                let parsed: any = await parser(cmd.payload, { literals: cmd.literals });
                assert.deepEqual(parsed.attributes[1][1] as any, { type: 'LITERAL', value: Buffer.from('hel\x00o', 'binary') });
                cmd.next();
            }
        };

        stream.on('readable', () => {
            if (!reading) {
                reading = true;
                reader()
                    .catch(err => assert.ifError(err))
                    .finally(() => {
                        reading = false;
                    });
            }
        });

        stream.on('error', err => {
            assert.ifError(err);
        });

        stream.on('end', () => {
            done();
        });

        stream.end(input);
    });
    it('Single byte', (t, done) => {
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
                assert.deepEqual({ command: cmd.payload.toString(), literals: cmd.literals.map((literal: any) => literal.toString()) }, expecting.shift());
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
            assert.ifError(err);
        });

        stream.on('end', () => {
            done();
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

        writer().catch(err => assert.ifError(err));
    });
});
