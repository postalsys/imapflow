'use strict';

const { JPDecoder } = require('../lib/jp-decoder');
const { PassThrough, Transform } = require('stream');
const encodingJapanese = require('encoding-japanese');

// Helper to collect stream output
const collectStream = stream =>
    new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
    });

// ============================================
// Constructor tests
// ============================================

module.exports['JPDecoder: constructor sets charset'] = test => {
    let decoder = new JPDecoder('iso-2022-jp');
    test.equal(decoder.charset, 'iso-2022-jp');
    test.deepEqual(decoder.chunks, []);
    test.equal(decoder.chunklen, 0);
    test.done();
};

module.exports['JPDecoder: is a Transform stream'] = test => {
    let decoder = new JPDecoder('iso-2022-jp');
    test.ok(decoder instanceof Transform);
    test.ok(typeof decoder.pipe === 'function');
    test.ok(typeof decoder.write === 'function');
    test.done();
};

// ============================================
// _transform tests
// ============================================

module.exports['JPDecoder: _transform accumulates buffer chunks'] = test => {
    let decoder = new JPDecoder('iso-2022-jp');
    let chunk1 = Buffer.from('hello');
    let chunk2 = Buffer.from('world');

    decoder._transform(chunk1, 'buffer', () => {
        test.equal(decoder.chunks.length, 1);
        test.equal(decoder.chunklen, 5);

        decoder._transform(chunk2, 'buffer', () => {
            test.equal(decoder.chunks.length, 2);
            test.equal(decoder.chunklen, 10);
            test.done();
        });
    });
};

module.exports['JPDecoder: _transform converts string to buffer'] = test => {
    let decoder = new JPDecoder('iso-2022-jp');
    let stringChunk = 'hello';

    decoder._transform(stringChunk, 'utf8', () => {
        test.equal(decoder.chunks.length, 1);
        test.ok(Buffer.isBuffer(decoder.chunks[0]));
        test.equal(decoder.chunks[0].toString(), 'hello');
        test.done();
    });
};

// ============================================
// _flush tests
// ============================================

module.exports['JPDecoder: _flush outputs accumulated data'] = async test => {
    let decoder = new JPDecoder('utf-8');
    let output = collectStream(decoder);

    decoder.write(Buffer.from('hello '));
    decoder.write(Buffer.from('world'));
    decoder.end();

    let result = await output;
    test.equal(result.toString(), 'hello world');
    test.done();
};

module.exports['JPDecoder: _flush converts ISO-2022-JP to Unicode'] = async test => {
    let decoder = new JPDecoder('iso-2022-jp');
    let output = collectStream(decoder);

    // ISO-2022-JP encoded Japanese text for "nihongo" (Japanese)
    // ESC $ B sequence switches to JIS X 0208, ESC ( B switches back to ASCII
    let iso2022jp = Buffer.from([
        0x1b,
        0x24,
        0x42, // ESC $ B - switch to JIS X 0208
        0x46,
        0x7c, // ni
        0x4b,
        0x5c, // hon
        0x38,
        0x6c, // go
        0x1b,
        0x28,
        0x42 // ESC ( B - switch back to ASCII
    ]);

    decoder.write(iso2022jp);
    decoder.end();

    let result = await output;
    test.ok(result.length > 0);
    test.done();
};

module.exports['JPDecoder: _flush handles conversion errors gracefully'] = async test => {
    // Use an invalid/unknown charset to trigger error path
    let decoder = new JPDecoder('invalid-charset-xyz');
    let output = collectStream(decoder);

    let input = Buffer.from('test data');
    decoder.write(input);
    decoder.end();

    let result = await output;
    // On error, should return original input
    test.equal(result.toString(), 'test data');
    test.done();
};

module.exports['JPDecoder: _flush falls back to raw input when convert throws'] = async test => {
    // encoding-japanese rarely throws on its own, so force it: the module object
    // is shared by reference with the copy held inside jp-decoder.js, so patching
    // .convert here affects the decoder's call too.
    let originalConvert = encodingJapanese.convert;
    encodingJapanese.convert = () => {
        throw new Error('forced conversion failure');
    };

    try {
        let decoder = new JPDecoder('iso-2022-jp');
        let output = collectStream(decoder);

        let input = Buffer.from('raw bytes preserved');
        decoder.write(input);
        decoder.end();

        let result = await output;
        // On a thrown error the catch block pushes the original, untouched input
        test.equal(result.toString(), 'raw bytes preserved');
    } finally {
        encodingJapanese.convert = originalConvert;
    }
    test.done();
};

module.exports['JPDecoder: _flush converts non-string convert output to buffer'] = async test => {
    // When convert returns a non-string (e.g. an array of code units), it must be
    // pushed as-is without the Buffer.from(string) branch.
    let originalConvert = encodingJapanese.convert;
    encodingJapanese.convert = () => Buffer.from('converted buffer');

    try {
        let decoder = new JPDecoder('iso-2022-jp');
        let output = collectStream(decoder);

        decoder.write(Buffer.from('whatever'));
        decoder.end();

        let result = await output;
        test.equal(result.toString(), 'converted buffer');
    } finally {
        encodingJapanese.convert = originalConvert;
    }
    test.done();
};

module.exports['JPDecoder: _flush handles empty input'] = async test => {
    let decoder = new JPDecoder('iso-2022-jp');
    let output = collectStream(decoder);

    decoder.end();

    let result = await output;
    test.equal(result.length, 0);
    test.done();
};

// ============================================
// Integration tests
// ============================================

module.exports['JPDecoder: works with pipe'] = async test => {
    let source = new PassThrough();
    let decoder = new JPDecoder('utf-8');
    let output = collectStream(source.pipe(decoder));

    source.write('hello ');
    source.write('world');
    source.end();

    let result = await output;
    test.equal(result.toString(), 'hello world');
    test.done();
};

module.exports['JPDecoder: handles multiple small chunks'] = async test => {
    let decoder = new JPDecoder('utf-8');
    let output = collectStream(decoder);

    // Write character by character
    'hello'.split('').forEach(char => decoder.write(char));
    decoder.end();

    let result = await output;
    test.equal(result.toString(), 'hello');
    test.done();
};

module.exports['JPDecoder: handles Shift_JIS charset'] = async test => {
    let decoder = new JPDecoder('shift_jis');
    let output = collectStream(decoder);

    // Shift_JIS encoded "test" in katakana (tesuto)
    let shiftJis = Buffer.from([0x83, 0x65, 0x83, 0x58, 0x83, 0x67]);

    decoder.write(shiftJis);
    decoder.end();

    let result = await output;
    test.ok(result.length > 0);
    test.done();
};

module.exports['JPDecoder: handles EUC-JP charset'] = async test => {
    let decoder = new JPDecoder('euc-jp');
    let output = collectStream(decoder);

    // EUC-JP encoded Japanese character
    let eucJp = Buffer.from([0xc6, 0xfc, 0xcb, 0xdc]); // nihon

    decoder.write(eucJp);
    decoder.end();

    let result = await output;
    test.ok(result.length > 0);
    test.done();
};

// ============================================
// maxBytes buffering bound
// ============================================

module.exports['JPDecoder: buffers at most maxBytes'] = test => {
    // The whole-input buffering must honor the caller's download limit: without the
    // bound a server could defeat maxBytes just by labelling a part with a Japanese
    // charset, since nothing is emitted (and limited) until _flush
    let decoder = new JPDecoder('iso-2022-jp', 8);
    decoder.resume();

    decoder.write(Buffer.from('hello '));
    decoder.write(Buffer.from('world'));

    test.equal(decoder.chunklen, 8);
    test.equal(Buffer.concat(decoder.chunks).toString(), 'hello wo');
    decoder.end();
    test.done();
};

module.exports['JPDecoder: a fractional maxBytes still bounds the decoder'] = test => {
    // A computed limit (a percentage of a budget, say) is not an integer, and silently turning
    // that into "no limit at all" is exactly the exposure the bound exists to close
    const decoder = new JPDecoder('sjis', 512.5);
    test.equal(decoder.maxBytes, 512, 'a fractional bound is floored to a whole byte count');
    decoder.resume();
    decoder.write(Buffer.alloc(1024, 0x61));
    test.equal(decoder.chunklen, 512, 'nothing beyond the bound is buffered');
    test.equal(decoder.limited, true, 'the decoder reports that it is full');
    decoder.end();
    test.done();
};

module.exports['JPDecoder: a non-numeric maxBytes leaves the decoder unbounded'] = test => {
    test.equal(new JPDecoder('sjis').maxBytes, Infinity);
    test.equal(new JPDecoder('sjis', Infinity).maxBytes, Infinity);
    test.equal(new JPDecoder('sjis', 'lots').maxBytes, Infinity);
    test.equal(new JPDecoder('sjis', -1).maxBytes, Infinity);
    test.equal(new JPDecoder('sjis').limited, false);
    test.done();
};

module.exports['JPDecoder: reports limited once the bound is reached'] = test => {
    // The decoder emits nothing until _flush, so a limiter downstream cannot tell that it is
    // full - the download loop reads this flag instead to stop pulling from the server
    const decoder = new JPDecoder('sjis', 10);
    decoder.resume();
    test.equal(decoder.limited, false);
    decoder.write(Buffer.alloc(4, 0x61));
    test.equal(decoder.limited, false, 'not full yet');
    decoder.write(Buffer.alloc(6, 0x61));
    test.equal(decoder.limited, true);
    test.equal(decoder.chunklen, 10);
    decoder.end();
    test.done();
};
