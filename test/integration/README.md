# Live IMAP4rev2 integration tests

Runs the ImapFlow client against a real IMAP4rev2 server - Dovecot 2.4+ in
Docker - instead of protocol mocks. Covers the ENABLE IMAP4rev2 negotiation,
LIST RETURN (SUBSCRIBED) without LSUB, subscription round-trips, UTF-8 mailbox
names, inline LIST-STATUS, ESEARCH responses to plain SEARCH, and a message
lifecycle smoke test with UID EXPUNGE.

## Running

```
npm run test:rev2
```

Requires Docker. The script pulls `dovecot/dovecot:2.4.4`, starts a container
with the drop-in config from `dovecot-test.conf`, waits for the IMAP greeting
on `127.0.0.1:31143`, runs `rev2-live-test.js` with nodeunit, and always
removes the container afterwards.

These tests are intentionally not part of `npm test` - the Gruntfile nodeunit
config excludes `test/integration/**`, so CI and plain test runs stay
Docker-free.

## Environment overrides

- `IMAPFLOW_DOVECOT_IMAGE` - image to run (default `dovecot/dovecot:2.4.4`;
  any 2.4.2+ tag supports IMAP4rev2)
- `IMAPFLOW_DOVECOT_PLATFORM` - e.g. `linux/amd64`; defaults to the host
  platform. Forcing `linux/amd64` on Apple Silicon does not work - Rosetta
  cannot start Dovecot's privilege-separated login processes
  (`rosetta error: mmap_anonymous_rw mmap failed`)
- `IMAPFLOW_TEST_PORT` - host port to publish (default 31143)

## Test account model

The container uses Dovecot's static passdb (`USER_PASSWORD=pass`): any
username authenticates with the password `pass` and gets its own empty mail
home, so every test connects as a brand-new user and needs no cleanup between
runs. Special-use mailboxes (Sent/Drafts/Junk/Trash) are auto-created and
subscribed via `dovecot-test.conf`.
