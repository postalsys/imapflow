'use strict';

const { LimitedPassthrough } = require('../lib/limited-passthrough');
const { PassThrough, Transform } = require('stream');

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

module.exports['LimitedPassthrough: constructor with options'] = test => {
    let stream = new LimitedPassthrough({ maxBytes: 100 });
    test.equal(stream.maxBytes, 100);
    test.equal(stream.processed, 0);
    test.equal(stream.limited, false);
    test.done();
};

module.exports['LimitedPassthrough: constructor with no options'] = test => {
    let stream = new LimitedPassthrough();
    test.equal(stream.maxBytes, Infinity);
    test.equal(stream.processed, 0);
    test.equal(stream.limited, false);
    test.done();
};

module.exports['LimitedPassthrough: constructor with null options'] = test => {
    let stream = new LimitedPassthrough(null);
    test.equal(stream.maxBytes, Infinity);
    test.done();
};

module.exports['LimitedPassthrough: is a Transform stream'] = test => {
    let stream = new LimitedPassthrough();
    test.ok(stream instanceof Transform);
    test.ok(typeof stream.pipe === 'function');
    test.ok(typeof stream.write === 'function');
    test.done();
};

// ============================================
// _transform tests - no limit
// ============================================

module.exports['LimitedPassthrough: passes all data when no limit'] = async test => {
    let stream = new LimitedPassthrough();
    let output = collectStream(stream);

    stream.write(Buffer.from('hello '));
    stream.write(Buffer.from('world'));
    stream.end();

    let result = await output;
    test.equal(result.toString(), 'hello world');
    test.equal(stream.processed, 11);
    test.equal(stream.limited, false);
    test.done();
};

// ============================================
// _transform tests - with limit
// ============================================

module.exports['LimitedPassthrough: limits output to maxBytes'] = async test => {
    let stream = new LimitedPassthrough({ maxBytes: 5 });
    let output = collectStream(stream);

    stream.write(Buffer.from('hello world'));
    stream.end();

    let result = await output;
    test.equal(result.toString(), 'hello');
    test.equal(stream.processed, 5);
    test.equal(stream.limited, true);
    test.done();
};

module.exports['LimitedPassthrough: limits across multiple chunks'] = async test => {
    let stream = new LimitedPassthrough({ maxBytes: 8 });
    let output = collectStream(stream);

    stream.write(Buffer.from('hello ')); // 6 bytes
    stream.write(Buffer.from('world')); // 5 bytes, only 2 should pass
    stream.end();

    let result = await output;
    test.equal(result.toString(), 'hello wo');
    test.equal(stream.processed, 8);
    test.equal(stream.limited, true);
    test.done();
};

module.exports['LimitedPassthrough: drops data after limit reached'] = async test => {
    let stream = new LimitedPassthrough({ maxBytes: 5 });
    let output = collectStream(stream);

    stream.write(Buffer.from('hello')); // exactly 5 bytes
    stream.write(Buffer.from(' world')); // should be dropped
    stream.write(Buffer.from('!')); // should be dropped
    stream.end();

    let result = await output;
    test.equal(result.toString(), 'hello');
    test.equal(stream.limited, true);
    test.done();
};

module.exports['LimitedPassthrough: handles exact boundary'] = async test => {
    let stream = new LimitedPassthrough({ maxBytes: 5 });
    let output = collectStream(stream);

    stream.write(Buffer.from('hello')); // exactly 5 bytes
    stream.end();

    let result = await output;
    test.equal(result.toString(), 'hello');
    test.equal(stream.processed, 5);
    test.equal(stream.limited, true);
    test.done();
};

module.exports['LimitedPassthrough: zero maxBytes treated as Infinity'] = async test => {
    // Note: maxBytes: 0 is falsy, so constructor uses Infinity instead
    let stream = new LimitedPassthrough({ maxBytes: 0 });
    test.equal(stream.maxBytes, Infinity);

    let output = collectStream(stream);
    stream.write(Buffer.from('hello'));
    stream.end();

    let result = await output;
    // All data passes through since 0 is treated as Infinity
    test.equal(result.toString(), 'hello');
    test.done();
};

module.exports['LimitedPassthrough: handles limit of 1 byte'] = async test => {
    let stream = new LimitedPassthrough({ maxBytes: 1 });
    let output = collectStream(stream);

    stream.write(Buffer.from('hello'));
    stream.end();

    let result = await output;
    test.equal(result.toString(), 'h');
    test.equal(stream.processed, 1);
    test.equal(stream.limited, true);
    test.done();
};

// ============================================
// Edge cases
// ============================================

module.exports['LimitedPassthrough: handles empty writes'] = async test => {
    let stream = new LimitedPassthrough({ maxBytes: 10 });
    let output = collectStream(stream);

    stream.write(Buffer.from(''));
    stream.write(Buffer.from('hello'));
    stream.write(Buffer.from(''));
    stream.end();

    let result = await output;
    test.equal(result.toString(), 'hello');
    test.equal(stream.processed, 5);
    test.done();
};

module.exports['LimitedPassthrough: handles no writes'] = async test => {
    let stream = new LimitedPassthrough({ maxBytes: 10 });
    let output = collectStream(stream);

    stream.end();

    let result = await output;
    test.equal(result.length, 0);
    test.equal(stream.processed, 0);
    test.equal(stream.limited, false);
    test.done();
};

module.exports['LimitedPassthrough: tracks processed bytes correctly'] = async test => {
    let stream = new LimitedPassthrough({ maxBytes: 100 });
    let output = collectStream(stream);

    stream.write(Buffer.from('12345')); // 5 bytes
    test.equal(stream.processed, 5);

    stream.write(Buffer.from('67890')); // 5 more bytes
    test.equal(stream.processed, 10);

    stream.end();

    await output;
    test.equal(stream.processed, 10);
    test.done();
};

// ============================================
// Integration tests
// ============================================

module.exports['LimitedPassthrough: works with pipe'] = async test => {
    let source = new PassThrough();
    let limiter = new LimitedPassthrough({ maxBytes: 10 });
    let output = collectStream(source.pipe(limiter));

    source.write('hello ');
    source.write('wonderful ');
    source.write('world');
    source.end();

    let result = await output;
    test.equal(result.toString(), 'hello wond');
    test.equal(limiter.limited, true);
    test.done();
};

module.exports['LimitedPassthrough: handles large data'] = async test => {
    let stream = new LimitedPassthrough({ maxBytes: 1000 });
    let output = collectStream(stream);

    // Write 100 bytes at a time
    for (let i = 0; i < 20; i++) {
        stream.write(Buffer.alloc(100, 'x'));
    }
    stream.end();

    let result = await output;
    test.equal(result.length, 1000);
    test.equal(stream.limited, true);
    test.done();
};

module.exports['LimitedPassthrough: single byte writes'] = async test => {
    let stream = new LimitedPassthrough({ maxBytes: 3 });
    let output = collectStream(stream);

    stream.write(Buffer.from('a'));
    stream.write(Buffer.from('b'));
    stream.write(Buffer.from('c'));
    stream.write(Buffer.from('d')); // should be dropped
    stream.write(Buffer.from('e')); // should be dropped
    stream.end();

    let result = await output;
    test.equal(result.toString(), 'abc');
    test.done();
};
