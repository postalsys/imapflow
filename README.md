# ImapFlow

Modern and easy-to-use IMAP client library for Node.js.

[![npm](https://img.shields.io/npm/v/imapflow)](https://www.npmjs.com/package/imapflow)
[![license](https://img.shields.io/npm/l/imapflow)](https://github.com/postalsys/imapflow/blob/master/LICENSE)

ImapFlow provides a clean, promise-based API for working with IMAP, so you don't need in-depth knowledge of the protocol. IMAP extensions are detected and handled automatically -- you write the same code regardless of server capabilities, and ImapFlow adapts behind the scenes.

## Features

- **Async/await API** -- all methods return Promises
- **Automatic IMAP extension handling** -- CONDSTORE, QRESYNC, IDLE, COMPRESS, and [more](https://imapflow.com/docs/)
- **Message streaming** -- async iterators for efficient processing
- **Mailbox locking** -- built-in locking mechanism for safe concurrent access
- **TypeScript support** -- type definitions included
- **Proxy support** -- SOCKS and HTTP CONNECT proxies
- **Gmail support** -- labels, raw search via X-GM-EXT-1

## Installation

```bash
npm install imapflow
```

## Quick Example

```js
const { ImapFlow } = require('imapflow');

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

See the [Quick Start guide](https://imapflow.com/docs/getting-started/quick-start) for more examples, including Gmail, Outlook, and Yahoo configuration.

## Documentation

Full documentation is available at **[imapflow.com](https://imapflow.com/docs/)**.

- [Installation](https://imapflow.com/docs/getting-started/installation) -- requirements and setup
- [Quick Start](https://imapflow.com/docs/getting-started/quick-start) -- your first ImapFlow application
- [Basic Usage](https://imapflow.com/docs/guides/basic-usage) -- core concepts and patterns
- [Configuration](https://imapflow.com/docs/guides/configuration) -- connection options and settings
- [Fetching Messages](https://imapflow.com/docs/guides/fetching-messages) -- reading email data
- [Searching](https://imapflow.com/docs/guides/searching) -- finding messages with search queries
- [Mailbox Management](https://imapflow.com/docs/guides/mailbox-management) -- creating, renaming, and deleting mailboxes
- [API Reference](https://imapflow.com/docs/api/imapflow-client) -- complete method and event documentation

> [!NOTE]
> If you are looking for a complete email integration solution, ImapFlow was built for [EmailEngine](https://emailengine.app/) -- a self-hosted email gateway that provides REST API access to IMAP and SMTP accounts.

## License

Copyright (c) 2020-2025 Postal Systems OU

Licensed under the MIT license.
