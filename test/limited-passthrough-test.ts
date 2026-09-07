import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LimitedPassthrough } from '../src/limited-passthrough.js';
import { PassThrough, Transform } from 'node:stream';

// Helper to collect stream output
const collectStream: any = (stream: any) =>
    new Promise((resolve, reject) => {
        const chunks: any = [];
        stream.on('data', (chunk: any) => chunks.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
    });

describe('limited-passthrough', () => {
    // ============================================
    // Constructor tests
    // ============================================
    it('LimitedPassthrough: constructor with options', () => {
        let stream = new LimitedPassthrough({ maxBytes: 100 });
        assert.equal(stream.maxBytes, 100);
        assert.equal(stream.processed, 0);
        assert.equal(stream.limited, false);
    });
    it('LimitedPassthrough: constructor with no options', () => {
        let stream = new LimitedPassthrough();
        assert.equal(stream.maxBytes, Infinity);
        assert.equal(stream.processed, 0);
        assert.equal(stream.limited, false);
    });
    it('LimitedPassthrough: constructor with null options', () => {
        let stream = new LimitedPassthrough(null as any);
        assert.equal(stream.maxBytes, Infinity);
    });
    it('LimitedPassthrough: is a Transform stream', () => {
        let stream = new LimitedPassthrough();
        assert.ok(stream instanceof Transform);
        assert.ok(typeof stream.pipe === 'function');
        assert.ok(typeof stream.write === 'function');
    });

    // ============================================
    // _transform tests - no limit
    // ============================================
    it('LimitedPassthrough: passes all data when no limit', async () => {
        let stream = new LimitedPassthrough();
        let output = collectStream(stream);

        stream.write(Buffer.from('hello '));
        stream.write(Buffer.from('world'));
        stream.end();

        let result: any = await output;
        assert.equal(result.toString(), 'hello world');
        assert.equal(stream.processed, 11);
        assert.equal(stream.limited, false);
    });

    // ============================================
    // _transform tests - with limit
    // ============================================
    it('LimitedPassthrough: limits output to maxBytes', async () => {
        let stream = new LimitedPassthrough({ maxBytes: 5 });
        let output = collectStream(stream);

        stream.write(Buffer.from('hello world'));
        stream.end();

        let result: any = await output;
        assert.equal(result.toString(), 'hello');
        assert.equal(stream.processed, 5);
        assert.equal(stream.limited, true);
    });
    it('LimitedPassthrough: limits across multiple chunks', async () => {
        let stream = new LimitedPassthrough({ maxBytes: 8 });
        let output = collectStream(stream);

        stream.write(Buffer.from('hello ')); // 6 bytes
        stream.write(Buffer.from('world')); // 5 bytes, only 2 should pass
        stream.end();

        let result: any = await output;
        assert.equal(result.toString(), 'hello wo');
        assert.equal(stream.processed, 8);
        assert.equal(stream.limited, true);
    });
    it('LimitedPassthrough: drops data after limit reached', async () => {
        let stream = new LimitedPassthrough({ maxBytes: 5 });
        let output = collectStream(stream);

        stream.write(Buffer.from('hello')); // exactly 5 bytes
        stream.write(Buffer.from(' world')); // should be dropped
        stream.write(Buffer.from('!')); // should be dropped
        stream.end();

        let result: any = await output;
        assert.equal(result.toString(), 'hello');
        assert.equal(stream.limited, true);
    });
    it('LimitedPassthrough: handles exact boundary', async () => {
        let stream = new LimitedPassthrough({ maxBytes: 5 });
        let output = collectStream(stream);

        stream.write(Buffer.from('hello')); // exactly 5 bytes
        stream.end();

        let result: any = await output;
        assert.equal(result.toString(), 'hello');
        assert.equal(stream.processed, 5);
        assert.equal(stream.limited, true);
    });
    it('LimitedPassthrough: zero maxBytes treated as Infinity', async () => {
        // Note: maxBytes: 0 is falsy, so constructor uses Infinity instead
        let stream = new LimitedPassthrough({ maxBytes: 0 });
        assert.equal(stream.maxBytes, Infinity);

        let output = collectStream(stream);
        stream.write(Buffer.from('hello'));
        stream.end();

        let result: any = await output;
        // All data passes through since 0 is treated as Infinity
        assert.equal(result.toString(), 'hello');
    });
    it('LimitedPassthrough: drops chunk when no remaining budget but not yet limited', async () => {
        // Force the remainingBytes<1 guard (distinct from the `this.limited` fast path):
        // override maxBytes to 0 after construction so the very first chunk hits it
        // while `limited` is still false.
        let stream = new LimitedPassthrough();
        stream.maxBytes = 0;
        let output = collectStream(stream);

        stream.write(Buffer.from('dropped'));
        stream.end();

        let result: any = await output;
        assert.equal(result.length, 0, 'chunk dropped when no budget remains');
        assert.equal(stream.limited, false, 'limited flag never set via this path');
    });
    it('LimitedPassthrough: handles limit of 1 byte', async () => {
        let stream = new LimitedPassthrough({ maxBytes: 1 });
        let output = collectStream(stream);

        stream.write(Buffer.from('hello'));
        stream.end();

        let result: any = await output;
        assert.equal(result.toString(), 'h');
        assert.equal(stream.processed, 1);
        assert.equal(stream.limited, true);
    });

    // ============================================
    // Edge cases
    // ============================================
    it('LimitedPassthrough: handles empty writes', async () => {
        let stream = new LimitedPassthrough({ maxBytes: 10 });
        let output = collectStream(stream);

        stream.write(Buffer.from(''));
        stream.write(Buffer.from('hello'));
        stream.write(Buffer.from(''));
        stream.end();

        let result: any = await output;
        assert.equal(result.toString(), 'hello');
        assert.equal(stream.processed, 5);
    });
    it('LimitedPassthrough: handles no writes', async () => {
        let stream = new LimitedPassthrough({ maxBytes: 10 });
        let output = collectStream(stream);

        stream.end();

        let result: any = await output;
        assert.equal(result.length, 0);
        assert.equal(stream.processed, 0);
        assert.equal(stream.limited, false);
    });
    it('LimitedPassthrough: tracks processed bytes correctly', async () => {
        let stream = new LimitedPassthrough({ maxBytes: 100 });
        let output = collectStream(stream);

        stream.write(Buffer.from('12345')); // 5 bytes
        assert.equal(stream.processed, 5);

        stream.write(Buffer.from('67890')); // 5 more bytes
        assert.equal(stream.processed, 10);

        stream.end();

        await output;
        assert.equal(stream.processed, 10);
    });

    // ============================================
    // Integration tests
    // ============================================
    it('LimitedPassthrough: works with pipe', async () => {
        let source = new PassThrough();
        let limiter = new LimitedPassthrough({ maxBytes: 10 });
        let output = collectStream(source.pipe(limiter));

        source.write('hello ');
        source.write('wonderful ');
        source.write('world');
        source.end();

        let result: any = await output;
        assert.equal(result.toString(), 'hello wond');
        assert.equal(limiter.limited, true);
    });
    it('LimitedPassthrough: handles large data', async () => {
        let stream = new LimitedPassthrough({ maxBytes: 1000 });
        let output = collectStream(stream);

        // Write 100 bytes at a time
        for (let i = 0; i < 20; i++) {
            stream.write(Buffer.alloc(100, 'x'));
        }
        stream.end();

        let result: any = await output;
        assert.equal(result.length, 1000);
        assert.equal(stream.limited, true);
    });
    it('LimitedPassthrough: single byte writes', async () => {
        let stream = new LimitedPassthrough({ maxBytes: 3 });
        let output = collectStream(stream);

        stream.write(Buffer.from('a'));
        stream.write(Buffer.from('b'));
        stream.write(Buffer.from('c'));
        stream.write(Buffer.from('d')); // should be dropped
        stream.write(Buffer.from('e')); // should be dropped
        stream.end();

        let result: any = await output;
        assert.equal(result.toString(), 'abc');
    });
    it('LimitedPassthrough: a fractional maxBytes is floored so limited is reachable', async () => {
        // With a fractional bound `processed` can only ever reach its floor, so `limited` would
        // never flip - and the download loop polls exactly that flag to stop pulling
        let stream = new LimitedPassthrough({ maxBytes: 512.5 });
        assert.equal(stream.maxBytes, 512);

        let chunks: any = [];
        stream.on('data', chunk => chunks.push(chunk));
        stream.write(Buffer.alloc(1024, 0x61));
        stream.end();
        await new Promise(resolve => stream.on('end', resolve));

        assert.equal(Buffer.concat(chunks).length, 512);
        assert.equal(stream.limited, true, 'the limiter must report that it is full');
    });
    it('LimitedPassthrough: a numeric-string maxBytes is honored', () => {
        assert.equal(new LimitedPassthrough({ maxBytes: '100' } as any).maxBytes, 100);
        assert.equal(new LimitedPassthrough({ maxBytes: 'lots' } as any).maxBytes, Infinity);
        assert.equal(new LimitedPassthrough({ maxBytes: -5 }).maxBytes, Infinity);
    });
});
