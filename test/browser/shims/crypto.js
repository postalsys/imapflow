// node:crypto in the browser bundle. ImapFlow hashes path:uidValidity:uid with MD5 into the id of
// a fetched message when the server has no OBJECTID; browsers have no MD5 (and Web Crypto is
// asynchronous), so the shim brings its own

/* eslint-disable no-bitwise */ // MD5 is bit arithmetic

const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

function md5(bytes) {
    const length = bytes.length;
    const padded = new Uint8Array(((length + 8) >> 6) * 64 + 64);
    padded.set(bytes);
    padded[length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, (length * 8) >>> 0, true);
    view.setUint32(padded.length - 4, Math.floor(length / 0x20000000), true);

    let a0 = 0x67452301;
    let b0 = 0xefcdab89;
    let c0 = 0x98badcfe;
    let d0 = 0x10325476;
    for (let offset = 0; offset < padded.length; offset += 64) {
        let [a, b, c, d] = [a0, b0, c0, d0];
        for (let i = 0; i < 64; i++) {
            let f;
            let g;
            if (i < 16) {
                f = (b & c) | (~b & d);
                g = i;
            } else if (i < 32) {
                f = (d & b) | (~d & c);
                g = (5 * i + 1) % 16;
            } else if (i < 48) {
                f = b ^ c ^ d;
                g = (3 * i + 5) % 16;
            } else {
                f = c ^ (b | ~d);
                g = (7 * i) % 16;
            }
            f = (f + a + K[i] + view.getUint32(offset + g * 4, true)) >>> 0;
            a = d;
            d = c;
            c = b;
            const shift = S[(i >> 4) * 4 + (i % 4)];
            b = (b + ((f << shift) | (f >>> (32 - shift)))) >>> 0;
        }
        a0 = (a0 + a) >>> 0;
        b0 = (b0 + b) >>> 0;
        c0 = (c0 + c) >>> 0;
        d0 = (d0 + d) >>> 0;
    }
    const out = new Uint8Array(16);
    const outView = new DataView(out.buffer);
    [a0, b0, c0, d0].forEach((word, i) => outView.setUint32(i * 4, word, true));
    return out;
}

export function createHash(algorithm) {
    if (algorithm !== 'md5') {
        throw new Error(`The ${algorithm} hash is not available in the browser`);
    }
    const chunks = [];
    return {
        update(data) {
            chunks.push(typeof data === 'string' ? new TextEncoder().encode(data) : data);
            return this;
        },
        digest(encoding) {
            const all = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
            let offset = 0;
            for (const chunk of chunks) {
                all.set(chunk, offset);
                offset += chunk.length;
            }
            const hash = md5(all);
            return encoding === 'hex' ? Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('') : hash;
        }
    };
}

export default { createHash };
