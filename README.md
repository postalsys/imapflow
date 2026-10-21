# ImapFlow

Modern and easy-to-use IMAP client library for Node.js.

[![npm](https://img.shields.io/npm/v/imapflow)](https://www.npmjs.com/package/imapflow)
[![license](https://img.shields.io/npm/l/imapflow)](https://github.com/postalsys/imapflow/blob/master/LICENSE)

ImapFlow provides a clean, promise-based API for working with IMAP, so you don't need in-depth knowledge of the protocol. IMAP extensions are detected and handled automatically. You write the same code regardless of server capabilities, and ImapFlow adapts behind the scenes. ImapFlow is the IMAP engine that powers [EmailEngine](https://emailengine.app/?utm_source=imapflow-readme&utm_medium=readme&utm_campaign=oss-docs&utm_content=intro), a self-hosted email API built by the same team.

## Features

- **Async/await API** - all methods return Promises
- **Automatic IMAP extension handling** - CONDSTORE, QRESYNC, IDLE, COMPRESS, and [more](https://imapflow.com/docs/)
- **Message streaming** - async iterators for efficient processing
- **Mailbox locking** - built-in locking mechanism for safe concurrent access
- **TypeScript support** - written in TypeScript, type definitions included
- **ES modules and CommonJS** - `import { ImapFlow } from 'imapflow'` and `const { ImapFlow } = require('imapflow')` both work
- **Proxy support** - SOCKS and HTTP CONNECT proxies
- **Gmail support** - labels, raw search via X-GM-EXT-1

## Installation

```bash
npm install imapflow
```

ImapFlow requires Node.js 20 or newer. The package ships both an ES module build and a CommonJS build with bundled type declarations, so no separate `@types` package is needed.

The ES module build also runs on [Bun](https://bun.sh/) (tested against the latest release) and on [Cloudflare Workers](https://developers.cloudflare.com/workers/) with the `nodejs_compat` compatibility flag. On Workers connect with implicit TLS (`secure: true`, usually port 993) or in cleartext: the runtime can not upgrade an already connected socket, so a STARTTLS negotiation fails with a TLS error, and it does not allow turning certificate validation off, so `tls: { rejectUnauthorized: false }` is rejected with `ERR_OPTION_NOT_IMPLEMENTED`. COMPRESS=DEFLATE, IDLE and the default pino logger work as on Node.js. STARTTLS works on Workers when the connection goes through `createSocketsTransport()` (see below).

[celld](https://celld.dev/), the self-hosted runtime for Cloudflare-style Workers, has no `node:net`, `node:tls` or `node:dns`. Pass the `connect()` of `cloudflare:sockets` through the `transport` option:

```js
import { connect } from 'cloudflare:sockets';
import { ImapFlow, createSocketsTransport } from 'imapflow';

const client = new ImapFlow({
    host: 'imap.example.com',
    port: 993,
    secure: true,
    auth: { user: 'user@example.com', pass: 'secret' },
    transport: createSocketsTransport(connect)
});
```

Implicit TLS, STARTTLS, cleartext, IDLE, `download()` and the default logger work. Not available there:

- The runtime verifies every certificate against its own root store, so `tls.rejectUnauthorized: false`, a custom `tls.ca`, client certificates and a `servername` that differs from `host` are refused with `UnsupportedTransportOption`. A TLS connection to an IP address needs a certificate issued for that address.
- COMPRESS=DEFLATE is skipped, the runtime has no streaming zlib.
- The `proxy` option can not be combined with a transport.
- `client.tls` stays `false`, the runtime reports no cipher details.
- A socket is closed when the request (or Durable Object event) that opened it ends. Run the whole session inside the handler, or inside `ctx.waitUntil()` to keep it going after the response.

### Other connections

The `transport` option takes any object with a `connect()` method, so other socket APIs plug in the same way. For an API built on web streams (a connection that opens with a promise of a `ReadableStream` and a `WritableStream` of bytes, as `cloudflare:sockets` and Chrome's Direct Sockets do), `createStreamsTransport()` does the wrapping:

```js
import { ImapFlow, createStreamsTransport } from 'imapflow';

const transport = createStreamsTransport({
    // `secure` says whether ImapFlow wants a TLS connection; throw to refuse what the API can not do
    open: ({ host, port, secure }) => {
        const socket = openSocket(host, port, secure);
        return {
            opened: socket.opened.then(() => ({ readable: socket.readable, writable: socket.writable })),
            close: () => socket.close()
        };
    },
    // optional: start TLS on an open connection after STARTTLS. Without it ImapFlow does not try
    // STARTTLS, and with doSTARTTLS: true the connection fails with err.tlsFailed set
    upgrade: (socket, options) => startTlsSomehow(socket)
});
```

`opened` may also report `remoteAddress`, `remotePort`, `localAddress` and `localPort`, and for a TLS connection `tls: { authorized, name, version }`, which becomes `client.tls`. If `close()` fails while the streams are locked, it is called again with the locks released.

An API built on events instead implements the transport itself: `connect(options, onConnect)` returns a Node.js `Duplex` stream of bytes and calls `onConnect` once the connection is up (or throws to refuse it), and an optional `upgrade(socket, options, onSecure)` starts TLS. The Duplex also needs `setTimeout(ms)`, emitting `timeout` after `ms` without traffic like `net.Socket` does: it is the watchdog behind the `socketTimeout` option.

In a browser, ImapFlow runs from the ES module build when the bundler provides what Node.js has and browsers do not:

- `node:stream` from [readable-stream](https://www.npmjs.com/package/readable-stream), `node:events` from [events](https://www.npmjs.com/package/events), and the `Buffer` global from [buffer](https://www.npmjs.com/package/buffer)
- the `process` global from [process](https://www.npmjs.com/package/process), and `setImmediate()` and `clearImmediate()` globals
- `node:crypto` with an MD5 `createHash()` (message ids on servers without OBJECTID), and `path` with `parse()` (used by a dependency for attachment file names)
- empty modules for `node:net`, `node:tls`, `node:dns` and `node:zlib` (COMPRESS is then skipped)

`test/browser/` in the repository has the complete esbuild setup, with the shims, and runs it in headless Chrome.

## Quick Example

```js
import { ImapFlow } from 'imapflow';
// or in CommonJS: const { ImapFlow } = require('imapflow');

const client = new ImapFlow({
    host: 'imap.example.com',
    port: 993,
    secure: true,
    auth: {
        user: 'user@example.com',
        pass: 'password'
    }
});

const main = async () => {
    await client.connect();

    let lock = await client.getMailboxLock('INBOX');
    try {
        // fetch latest message
        let message = await client.fetchOne(client.mailbox.exists, { source: true });
        console.log(message.source.toString());

        // list subjects for all messages
        for await (let message of client.fetch('1:*', { envelope: true })) {
            console.log(`${message.uid}: ${message.envelope.subject}`);
        }
    } finally {
        // always release the lock
        lock.release();
    }

    await client.logout();
};

main().catch(console.error);
```

An `ImapFlow` instance holds a single connection and cannot reconnect. Once the connection has closed, or after `connect()` has been called once, create a new instance to connect again. Calling `connect()` a second time on the same instance throws an error with the code `InstanceReused`.

### Connection state

Besides `mailbox`, `usable`, `authenticated` and `capabilities`, a client exposes:

- `client.context` - data of the application's own, never read by ImapFlow. It starts as the `context` option (`new ImapFlow({ ..., context: { account: 'a1' } })`) and can be replaced at any time. Its type is `unknown`, cast it to what you store there.
- `client.connectedAt` - when the TCP or TLS connection was established, in milliseconds since the epoch, `null` before that.
- `client.lastClientWrite` - when the client last wrote to the server (a command, a literal, the `DONE` that ends IDLE), in milliseconds since the epoch, `null` before the first write. Useful for staying ahead of server inactivity timers.
- `client.idlingAtClose` - whether the connection was in IDLE (or the polling fallback) when it closed. `idling` is already cleared when the `close` event fires, so this tells a server dropping an idle session from one dropping a session mid-command.
- `client.mailboxList` - with `verifyOnly` and `includeMailboxes`, the mailboxes listed before the connection logged out; `undefined` otherwise.

See the [Quick Start guide](https://imapflow.com/docs/getting-started/quick-start) for more examples, including Gmail, Outlook, and Yahoo configuration.

## Documentation

Full documentation is available at **[imapflow.com](https://imapflow.com/docs/)**.

- [Installation](https://imapflow.com/docs/getting-started/installation) - requirements and setup
- [Quick Start](https://imapflow.com/docs/getting-started/quick-start) - your first ImapFlow application
- [Basic Usage](https://imapflow.com/docs/guides/basic-usage) - core concepts and patterns
- [Configuration](https://imapflow.com/docs/guides/configuration) - connection options and settings
- [Fetching Messages](https://imapflow.com/docs/guides/fetching-messages) - reading email data
- [Searching](https://imapflow.com/docs/guides/searching) - finding messages with search queries
- [Mailbox Management](https://imapflow.com/docs/guides/mailbox-management) - creating, renaming, and deleting mailboxes
- [API Reference](https://imapflow.com/docs/api/imapflow-client) - complete method and event documentation

> ImapFlow was built for **[EmailEngine](https://emailengine.app/?utm_source=imapflow-readme&utm_medium=readme&utm_campaign=oss-docs&utm_content=note)**, a self-hosted email API that turns Gmail, Microsoft 365, and IMAP accounts into REST endpoints, with managed OAuth2 and webhooks for incoming mail. If you need a production email integration rather than an IMAP client, start there.

## License

Copyright (c) 2020-2025 Postal Systems OU

Licensed under the MIT license.
