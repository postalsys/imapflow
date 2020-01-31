# ImapFlow

IMAP Client for Node.js extracted from [NodemailerApp project](https://nodemailer.com/app/).

The focus for ImapFlow is to provide easy to use API over IMAP.

## Source

Source code is available from [Github](https://github.com/nodemailer/imapflow).

## Usage

First install the module from npm:

```
$ npm install imapflow
```

next import the ImapFlow class into your script:

```js
const { ImapFlow } = require('imapflow');
```

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
        let message = await client.fetchOne('*', { source: true });
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

ImapFlow has TS typings set for compatible editors.

## License

&copy; 2020 Andris Reinman

Licensed for evaluation use only
