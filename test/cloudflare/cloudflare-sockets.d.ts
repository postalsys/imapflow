// The cloudflare:sockets module the Workers and celld harnesses import, typed with the shape
// createSocketsTransport() takes
declare module 'cloudflare:sockets' {
    export const connect: import('../../src/sockets-transport.js').SocketsConnect;
}
