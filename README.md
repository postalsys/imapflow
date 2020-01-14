# ImapFlow

IMAP Client for Node.js extracted from [NodemailerApp project](https://nodemailer.com/app/).

The focus for ImapFlow is to provide easy to use API over IMAP.

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
    // wait until client connects and authorizes
    await client.connect();

    // select a mailbox
    await client.mailboxOpen('INBOX');

    // fetch latest message source
    let message = await client.fetchOne('*', { source: true });
    console.log(message.source.toString());

    // log out and close connection
    await client.logout();
};

main().catch(err => console.error(err));
```

## Documentation

[API reference](https://imapflow.com/ImapFlow.html).

ImapFlow has TS typings set for compatible editors.

## License

&copy; 2020 Andris Reinman

Licensed for evaluation use only
