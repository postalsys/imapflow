// Minimal declarations for the runtime dependencies that ship without type
// definitions. Only the members ImapFlow uses are declared.

declare module 'libmime' {
    export interface ParsedHeaderValue {
        value: string;
        params: { [key: string]: string };
    }
    export function parseHeaderValue(value: string | undefined): ParsedHeaderValue;
    export function decodeWords(value: string): string;
}

declare module 'libqp' {
    import { Transform } from 'node:stream';
    export class Decoder extends Transform {}
    export function decode(value: string | Buffer): Buffer;
}

declare module 'libbase64' {
    import { Transform } from 'node:stream';
    export class Decoder extends Transform {}
    export function decode(value: string | Buffer): Buffer;
}

declare module 'encoding-japanese' {
    export type Encoding = 'UTF8' | 'UTF16' | 'UTF16BE' | 'UTF16LE' | 'UTF32' | 'JIS' | 'SJIS' | 'EUCJP' | 'ASCII' | 'BINARY' | 'UNICODE' | 'AUTO';
    export interface ConvertOptions {
        to: Encoding;
        from?: Encoding | string | undefined;
        type?: 'string' | 'arraybuffer' | 'array' | undefined;
    }
    export function convert(data: Uint8Array | number[] | string, options: ConvertOptions): any;
    export function detect(data: Uint8Array | number[] | string): Encoding | false;
}
