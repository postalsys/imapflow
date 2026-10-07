# Live IMAP4rev2 integration tests

Runs the ImapFlow client against a real IMAP4rev2 server - Dovecot 2.4+ in
Docker - instead of protocol mocks. Covers the ENABLE IMAP4rev2 negotiation,
LIST RETURN (SUBSCRIBED) without LSUB, subscription round-trips, UTF-8 mailbox
names, inline LIST-STATUS (including the rev2 SIZE and DELETED status items),
ESEARCH responses to plain SEARCH, STATUS SIZE/DELETED, the rev2-shaped SELECT
response (untagged LIST, CLOSED on re-select), the folded-in FETCH BINARY,
COPYUID from the untagged OK on MOVE, and a message lifecycle smoke test with
UID EXPUNGE.

## Running

```
npm run test:rev2
```

Requires Docker. The script pulls `dovecot/dovecot:2.4.4`, starts a container
with the drop-in config from `dovecot-test.conf`, waits for the IMAP greeting
on `127.0.0.1:31143`, runs `rev2-live-test.ts` with the Node.js test runner
(through tsx), and always removes the container afterwards.

These tests are intentionally not part of `npm test` - the test file list
excludes `test/integration/**`, so plain test runs stay Docker-free.
CI runs this suite in a dedicated `test-rev2` job on `ubuntu-latest` (amd64
with Docker preinstalled), forcing `IMAPFLOW_DOVECOT_PLATFORM=linux/amd64` -
that job is the authoritative linux/amd64 run, since Apple Silicon machines
cannot execute the amd64 image (see below).

If a local image for the configured tag exists but was pulled for a different
architecture than the Docker host (e.g. an amd64 image left behind on an arm64
host), the runner script detects the mismatch and re-pulls the host-native
variant before starting the container.

## Environment overrides

- `IMAPFLOW_DOVECOT_IMAGE` - image to run (default `dovecot/dovecot:2.4.4`;
  any 2.4.2+ tag supports IMAP4rev2)
- `IMAPFLOW_DOVECOT_PLATFORM` - e.g. `linux/amd64`; defaults to the host
  platform. Forcing `linux/amd64` on Apple Silicon does not work - Rosetta
  cannot start Dovecot's privilege-separated login processes
  (`rosetta error: mmap_anonymous_rw mmap failed`; reconfirmed with
  dovecot/dovecot:2.4.4 in July 2026)
- `IMAPFLOW_TEST_PORT` - host port to publish (default 31143)

## Test account model

The container uses Dovecot's static passdb (`USER_PASSWORD=pass`): any
username authenticates with the password `pass` and gets its own empty mail
home, so every test connects as a brand-new user and needs no cleanup between
runs. Special-use mailboxes (Sent/Drafts/Junk/Trash) are auto-created and
subscribed via `dovecot-test.conf`.

# Live Apache James integration tests

Runs the ImapFlow client against Apache James, the server several hosted mail
services are built on (Twake Mail among them). James differs from Dovecot in
ways protocol mocks do not show, so `james-live-test.ts` drives the public API
end to end: the STARTTLS session, mailbox management, special-use mailboxes,
status and LIST-STATUS, search, flags with CONDSTORE through QRESYNC, copy,
move and delete with UIDPLUS, IDLE, QRESYNC VANISHED expunges, quota, fetch,
and `download()` / `downloadMany()` of every part shape.

## Running

```
npm run test:james
```

Requires Docker. The script starts `apache/james:memory-3.9.1` (the in-memory
distribution, nothing persists) with `james/start-james.sh` as its entrypoint,
waits for James to log that it started, runs `james-live-test.ts` and always
removes the container afterwards.

The image is only published for linux/amd64, so on Apple Silicon it runs
under emulation (it works, Java is fine with Rosetta). CI runs it natively in
the `test-james` job.

## Container setup

- The image's default configs point the IMAP, SMTP and POP3 servers at
  `conf/keystore` without shipping one, so James does not start as is.
  `start-james.sh` generates a throwaway self-signed keystore first.
- James sends LOGINDISABLED until STARTTLS, so the client upgrades the
  cleartext connection on port 143 (`tls.rejectUnauthorized: false`).
- `start-james.sh` pins the WebAdmin password so the tests can create a fresh
  `@example.com` user for every test case (`PUT /users/<user>`), the same
  isolation the Dovecot static passdb gives. New users get INBOX, Archive,
  Drafts, Outbox, Sent, Spam (`\Junk`) and Trash.

## Environment overrides

- `IMAPFLOW_JAMES_IMAGE` - image to run (default `apache/james:memory-3.9.1`)
- `IMAPFLOW_JAMES_PLATFORM` - default `linux/amd64`
- `IMAPFLOW_JAMES_PORT` - host port for IMAP (default 31144)
- `IMAPFLOW_JAMES_WEBADMIN_PORT` - host port for WebAdmin (default 31180)

## Known James quirks

- A FETCH that asks for two sections of the same MIME part (`BODY[2.MIME]`
  and `BODY[2]`) gets only the first one, the other comes back empty
  (`FetchGroup.addPartContent()`). `download()` and `downloadMany()` ask the
  empty section again on its own.
- QRESYNC is advertised without CONDSTORE and a lone `ENABLE CONDSTORE` is
  ignored. `ENABLE QRESYNC` (the `qresync` option) enables CONDSTORE too.
- About one FETCH answer in a few hundred is written out of order: the tail
  (` EMAILID (1))` and the tagged OK) goes out before the untagged head and its
  literal, which then run into the answer to the next command. Reproduced with
  a bare socket client inside the container's network namespace, in cleartext
  and over TLS, so it is James itself (seen under amd64 emulation on Apple
  Silicon). `download()` drops an answer whose UID or partial origin does not
  match the request and asks again, but a client can not repair the merged
  response. Reproduced on native linux/amd64 in CI as well. The download test
  of this suite uses the default chunk size, a few FETCHes per download instead
  of hundreds, to keep this server bug from failing it.
