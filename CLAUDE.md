# Claude Development Guidelines

## Project Overview

ImapFlow is a modern, promise-based IMAP client library for Node.js. It opens
TLS/cleartext connections to IMAP servers, authenticates, and parses untrusted
protocol responses from those servers into a friendly API. It is published to
npm as `imapflow` and ships TypeScript type definitions.

## Project Structure

- `lib/imap-flow.js` - Main `ImapFlow` client class (connection lifecycle, command dispatch, public API)
- `lib/imap-flow.d.ts` - TypeScript type definitions (published as `types`)
- `lib/imap-commands.js` - Registry wiring individual command implementations
- `lib/commands/` - Per-command implementations (login, fetch, search, append, etc.)
- `lib/handler/` - IMAP response stream parser and command compiler (tokenizer, literals, line handling)
- `lib/search-compiler.js` - Translates the search query object into IMAP SEARCH terms
- `lib/charsets.js`, `lib/jp-decoder.js` - Charset/encoding helpers
- `lib/special-use.js` - SPECIAL-USE mailbox detection
- `lib/proxy-connection.js` - SOCKS/HTTP proxy connection support
- `lib/limited-passthrough.js`, `lib/tools.js`, `lib/logger.js` - Internal utilities
- `test/` - Unit tests (`*-test.js`), run with nodeunit via Grunt
- `examples/` - Standalone usage examples (not production code)

## Technology Stack

- **Runtime**: Node.js (CI tests on 22.x and 24.x)
- **Module system**: CommonJS (see Packaging Constraints below)
- **Testing**: Grunt + grunt-contrib-nodeunit, ESLint via grunt-eslint
- **Lint/format**: ESLint (`eslint.config.js`, flat config) + Prettier
- **Key dependencies**: `@zone-eu/mailsplit`, `libmime`, `libqp`, `libbase64`, `iconv-lite`, `encoding-japanese`, `nodemailer`, `pino`, `socks`

## Development Commands

```
npm test           # Run full suite via Grunt (ESLint + nodeunit tests)
npm run coverage   # Run tests under c8 coverage (text + html reports)
npm run lint       # Lint with ESLint
npm run format     # Format with Prettier (js, json, md, yml, yaml)
npm run update     # Refresh deps: remove node_modules + lockfile, ncu -u, npm install
```

## Testing

- Tests live in `test/` and are named `*-test.js`; the Grunt nodeunit glob only matches that pattern, so helpers/fixtures are never run as tests.
- `npm test` runs `grunt`, which runs ESLint first, then the nodeunit suite. Keep the suite green and lint-clean before committing.
- New tests go in `test/` as `*-test.js`. The parser, command compiler, and search compiler are the most security-sensitive areas - add hostile/malformed-input cases there.

## Packaging Constraints (IMPORTANT)

EmailEngine (see "Relationship to EmailEngine" below) bundles ImapFlow and all
of its transitive dependencies into a single self-contained executable using
[`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg). `pkg` works by snapshotting a
CommonJS `require()` graph, so it **cannot bundle pure-ESM packages**.

Therefore ImapFlow itself and every dependency it pulls in must stay
CommonJS-compatible:

- ImapFlow source stays CommonJS (`require`/`module.exports`). Do not convert the library to ESM.
- Do not add a dependency that is pure ESM (`"type": "module"` with only an `import`/ESM entry and no CommonJS export). It must be `require()`-able.
- When `npm run update` or a new dependency would pull in a pure-ESM package (a common outcome of major-version bumps), pin to the last CommonJS-compatible version instead, or find a CommonJS alternative. Verify with a quick `require()` of the package after updating.
- Keep dynamic `require()` paths static enough for `pkg` to detect; avoid building module paths at runtime in ways the bundler can't trace.

## Code Style Rules

- Never use emojis in code or documentation, only printable ASCII characters.
- Use a single hyphen-minus (`-`) as a dash in user-facing strings and docs. Never use double hyphens (`--`), em dashes, or en dashes.
- When composing git commit messages, do not include Claude as a co-contributor.
- Use Conventional Commit prefixes (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `ci:`, ...). Versioning and the changelog are driven by these prefixes via release-please.
- For commits that do not change published runtime behavior (docs, comments, CI/workflow tweaks, formatting), append `[skip ci]` to the commit message to avoid triggering the GitHub Actions workflows. Exception: do not add `[skip ci]` to commits using a `fix:` or `feat:` prefix - those must run so the release action is triggered.
- After making code changes:
    1. Run `npm run format` and `npm run lint`
    2. Run `npm test` and keep it green
    3. For non-trivial changes, run `/simplify` to review changed code and `/security-review` to check for security issues before committing
- After pushing, check the GitHub Actions runs for the push (e.g. `gh run list --branch master`) and report their status, including the CodeQL "CodeQL Advanced" code-scanning run. If a run fails for a strange or unrelated reason (for example a checkout step reporting "account suspended", HTTP 403, or other auth/infrastructure errors that have nothing to do with the change), check <https://www.githubstatus.com/> for an active GitHub incident before assuming the failure is caused by the change.

## Relationship to EmailEngine

ImapFlow is developed and maintained primarily as the IMAP client used by
[EmailEngine](https://github.com/postalsys/emailengine). The local development
copy of EmailEngine lives at `../emailengine` relative to this project root. When
EmailEngine hits a bug or unhandled promise rejection that originates in
ImapFlow, the fix belongs here in the ImapFlow source rather than as a
workaround in EmailEngine. Because EmailEngine packages this library with
`@yao-pkg/pkg`, never make a change here that breaks CommonJS packaging (see
Packaging Constraints).

## Security

Security policy and private reporting channels are documented in
[`SECURITY.md`](SECURITY.md) / [`SECURITY.txt`](SECURITY.txt). Code scanning runs
through the "CodeQL Advanced" GitHub Actions workflow
(`.github/workflows/codeql.yml`, config in `.github/codeql/codeql-config.yml`).

## Release Process

Changelog and version numbers are managed automatically by the release-please GitHub Action. Do not check for or suggest CHANGELOG entries or version bumps during code reviews.
