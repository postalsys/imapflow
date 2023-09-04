# ImapFlow

ImapFlow is a modern and easy-to-use IMAP client library for Node.js.

> [!NOTE]
> Managing an IMAP connection is cool, but if you are only looking for an easy way to integrate email accounts, then ImapFlow was built for [EmailEngine Email API](https://emailengine.app/). It's a self-hosted software that converts all IMAP accounts to easy-to-use REST interfaces.

The focus for ImapFlow is to provide easy to use API over IMAP. Using ImapFlow does not expect knowledge about specific IMAP details. A general understanding is good enough.

IMAP extensions are handled in the background, so, for example, you can always request `labels` value from a {@link FetchQueryObject|fetch()} call, but if the IMAP server does not support `X-GM-EXT-1` extension, then `labels` value is not included in the response.

## Source

Source code is available from [Github](https://github.com/postalsys/imapflow).

## Usage

First install the module from npm:

```
$ npm install imapflow
```

next import the ImapFlow class into your script:

```js
const { ImapFlow } = require('imapflow');
```

### Promises

All ImapFlow methods use Promises, so you need to wait using `await` or wait for the `then()` method to fire until you get the response.

```js
const { ImapFlow } = require('imapflow');
const client = new ImapFlow({
    host: 'ethereal.email',
    port: 993,
    secure: true,
    auth: {
        user: 'garland.mcclure71@ethereal.email',
        pass: 'mW6e4wWWnEd3H4hT5B'
    }
});

const main = async () => {
    // Wait until client connects and authorizes
    await client.connect();

    // Select and lock a mailbox. Throws if mailbox does not exist
    let lock = await client.getMailboxLock('INBOX');
    try {
        // fetch latest message source
        // client.mailbox includes information about currently selected mailbox
        // "exists" value is also the largest sequence number available in the mailbox
        let message = await client.fetchOne(client.mailbox.exists, { source: true });
        console.log(message.source.toString());

        // list subjects for all messages
        // uid value is always included in FETCH response, envelope strings are in unicode.
        for await (let message of client.fetch('1:*', { envelope: true })) {
            console.log(`${message.uid}: ${message.envelope.subject}`);
        }
    } finally {
        // Make sure lock is released, otherwise next `getMailboxLock()` never returns
        lock.release();
    }

    // log out and close connection
    await client.logout();
};

main().catch(err => console.error(err));
```

## Documentation

[API reference](https://imapflow.com/module-imapflow-ImapFlow.html).

## License

&copy; 2020-2023 Postal Systems OÜ

Licensed under **MIT-license**
