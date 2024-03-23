import { Transform } from 'stream';

export class LimitedPassthrough extends Transform {
    limited: boolean;
    maxBytes: number;
    options: any;
    processed: number;

    constructor(options) {
        super();
        this.options = options || {};
        this.maxBytes = this.options.maxBytes || Infinity;
        this.processed = 0;
        this.limited = false;
    }

    override _transform(chunk, encoding, done) {
        if (this.limited) {
            return done();
        }

        if (this.processed + chunk.length > this.maxBytes) {
            if (this.maxBytes - this.processed < 1) {
                return done();
            }

            chunk = chunk.slice(0, this.maxBytes - this.processed);
        }

        this.processed += chunk.length;
        if (this.processed >= this.maxBytes) {
            this.limited = true;
        }

        this.push(chunk);
        done();
    }
}
