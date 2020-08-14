# ImapFlow

_IMAP Client library for [IMAP API](https://imapapi.com/)._

The focus for ImapFlow is to provide easy to use API over IMAP. Using ImapFlow does not expect knowledge about specific IMAP details, general understanding is good enough.

IMAP extensions are handled in the background, so for example you can always request `labels` value from a {@link FetchQueryObject|fetch()} call but if the IMAP server does not support `X-GM-EXT1` extension, then `labels` value is not included in the response.

## Source

Source code is available from [Github](https://github.com/andris9/imapflow).

## Usage

### Free, AGPL-licensed version

First install the module from npm:

```
$ npm install imapflow
```

next import the ImapFlow class into your script:

```js
const { ImapFlow } = require('imapflow');
```

### MIT version

MIT-licensed version is available for [Postal Systems subscribers](https://postalsys.com/).

First install the module from Postal Systems private registry:

```
$ npm install @postalsys/imapflow
```

next import the ImapFlow class into your script:

```js
const { ImapFlow } = require('@postalsys/imapflow');
```

If you have already built your application using the free version of ImapFlow and do not want to modify require statements in your code, you can install the MIT-licensed version as an alias for "imapflow".

```
$ npm install imapflow@npm:@postalsys/imapflow
```

This way you can keep using the old module name

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

## License

&copy; 2020 Andris Reinman

Licensed under GNU Affero General Public License v3.0 or later.

MIT-licensed version of ImapFlow is available for [Postal Systems subscribers](https://postalsys.com/).
