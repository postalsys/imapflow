import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readContent, rfc822, startImapKit } from '../fixtures/imapkit.js';

// ImapKit quirk presets reproduce the bugs of known real servers in every run, without the
// servers themselves. The probabilistic ones run with several seeds (scriptSeed), so a run is
// repeatable and still covers different orders of events.

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const PLUGINS = ['UIDPLUS', 'MOVE', 'ENABLE', 'CONDSTORE', 'ESEARCH'];

const TEXT = Array.from({ length: 1500 }, (_, i) => `line ${i} of the text part`).join('\r\n');
const ATTACHMENT = Buffer.from(Array.from({ length: 30000 }, (_, i) => (i * 7) % 256));
const MULTIPART =
    'From: a@example.com\r\nSubject: quirks\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n' +
    `--b\r\nContent-Type: text/plain\r\n\r\n${TEXT}\r\n` +
    '--b\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="data.bin"\r\n\r\n' +
    `${ATTACHMENT.toString('base64').replace(/.{76}/g, '$&\r\n')}\r\n--b--\r\n`;
const STORAGE = { INBOX: { messages: [{ raw: MULTIPART }, { raw: rfc822('short', 'hi') }, { raw: rfc822('third') }] } };

const start = (t: any, quirk: string, seed = 1) =>
    startImapKit(t, { allowBad: quirk === 'm365-throttle', server: { plugins: PLUGINS, storage: STORAGE, quirks: [quirk], scriptSeed: seed } });

// download() and downloadMany() of every part, the way EmailEngine fetches attachments by UID
const downloadsComplete = async (client: any) => {
    await client.mailboxOpen('INBOX');
    const text = await client.download('1', '1', { uid: true });
    assert.equal((await readContent(text.content)).toString().trim(), TEXT, 'text part');
    const attachment = await client.download('1', '2', { uid: true, chunkSize: 8000 });
    assert.ok((await readContent(attachment.content)).equals(ATTACHMENT), 'attachment');
    assert.equal(attachment.meta.filename, 'data.bin');
    const many = await client.downloadMany('1', ['1', '2'], { uid: true });
    assert.equal(many['1'].content.toString().trim(), TEXT, 'downloadMany text part');
    assert.ok(many['2'].content.equals(ATTACHMENT), 'downloadMany attachment');
    const short = await client.download('2', '1', { uid: true });
    assert.equal((await readContent(short.content)).toString().trim(), 'hi', 'single part message');
};

describe('imapkit quirks: Apache James', () => {
    it('james-fetchgroup: a part asked with its MIME headers still downloads whole (Twake Mail)', async t => {
        const kit = await start(t, 'james-fetchgroup');
        const client = await kit.connect();
        await downloadsComplete(client);
        await client.logout();
    });

    for (const seed of SEEDS) {
        it(`james-late-fetch: downloads complete when FETCH answers come after the tagged OK (seed ${seed})`, async t => {
            const kit = await start(t, 'james-late-fetch', seed);
            const client = await kit.connect();
            await downloadsComplete(client);
            await client.logout();
        });
    }

    it('james-late-fetch: a message that is really gone is still reported as not found', async t => {
        const kit = await start(t, 'james-late-fetch');
        const client = await kit.connect();
        await client.mailboxOpen('INBOX');
        assert.deepEqual(await client.download('99', '1', { uid: true }), {});
        await client.logout();
    });
});

describe('imapkit quirks: Yahoo', () => {
    it('yahoo-quoted-sections: short sections sent as quoted strings download (issue #403)', async t => {
        const kit = await start(t, 'yahoo-quoted-sections');
        const client = await kit.connect();
        await downloadsComplete(client);
        await client.logout();
    });
});

describe('imapkit quirks: Microsoft 365', () => {
    for (const seed of SEEDS) {
        it(`m365-throttle: FETCH is retried, other throttled commands fail with ETHROTTLE (seed ${seed})`, async t => {
            const kit = await start(t, 'm365-throttle', seed);
            // a throttled login is not a rejected credential: connecting again is the answer
            let client: any;
            for (let attempt = 1; !client; attempt++) {
                // the back-off is real time, only the waits are recorded
                client = await kit
                    .connect({}, (connecting: any) => t.mock.method(connecting, 'throttleWait', async () => false))
                    .catch((err: any) => {
                        assert.equal(err.code, 'ETHROTTLE', err.message);
                        assert.equal(err.authenticationFailed, undefined);
                        assert.ok(attempt < 5, 'connected within a few attempts');
                        return null;
                    });
            }
            // a throttled command either works or tells the caller to back off, never anything else
            const step = async (run: () => Promise<any>) => {
                try {
                    return await run();
                } catch (err: any) {
                    assert.equal(err.code, 'ETHROTTLE', err.message);
                    assert.equal(err.throttleReset, 1000);
                    return 'throttled';
                }
            };
            let opened = await step(() => client.mailboxOpen('INBOX'));
            if (opened === 'throttled') {
                opened = await client.mailboxOpen('INBOX');
            }
            assert.equal(opened.exists, 3);
            // FETCH retries on its own, so the data always arrives
            for (let i = 0; i < 5; i++) {
                const messages = await client.fetchAll('1:*', { uid: true, envelope: true });
                assert.deepEqual(
                    messages.map((message: any) => message.envelope.subject),
                    ['quirks', 'short', 'third']
                );
            }
            await step(() => client.status('INBOX', { messages: true }));
            await step(() => client.list());
            await client.logout().catch(() => false);
        });
    }
});

describe('imapkit quirks: missing extensions', () => {
    for (const quirk of ['no-uidplus', 'no-move']) {
        it(`${quirk}: copy and move work, with what the server can tell`, async t => {
            const kit = await start(t, quirk);
            const client = await kit.connect();
            assert.equal(client.capabilities.has(quirk === 'no-move' ? 'MOVE' : 'UIDPLUS'), false);
            await client.mailboxOpen('INBOX');
            await client.mailboxCreate('Archive');
            const copied = await client.messageCopy('2', 'Archive');
            const moved = await client.messageMove('3', 'Archive');
            assert.equal(copied.destination, 'Archive');
            assert.equal(moved.destination, 'Archive');
            // COPYUID comes with UIDPLUS only
            assert.equal(!!copied.uidMap, quirk !== 'no-uidplus');
            assert.equal(client.mailbox.exists, 2);
            assert.equal(kit.control.getMailbox('Archive').messages, 2);
            await client.logout();
        });
    }
});
