# Security Policy

ImapFlow is a Node.js IMAP client library. It opens TLS/cleartext connections to
IMAP servers, sends account credentials, and parses untrusted protocol responses
from those servers. Because it handles credentials and processes data from
remote servers that may be malicious or buggy, we take security reports
seriously and aim to respond quickly.

## Supported Versions

Security fixes are released only against the latest version. We do not backport
patches to older releases - upgrading to the current release line is the
supported way to receive security updates.

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |
| < 1.0   | :x:                |

If you are on an older version, please upgrade. See the release notes at
<https://github.com/postalsys/imapflow/releases> before updating.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
pull requests, or discussions.**

Report privately through one of the following channels:

1. **GitHub Security Advisories (preferred).** Open a private report at
   <https://github.com/postalsys/imapflow/security/advisories/new>. This keeps
   the discussion private until a fix is published and lets us credit you.
2. **Email.** Send details to **andris@postalsys.com** (the contact listed in
   [`SECURITY.txt`](SECURITY.txt)). Encrypt sensitive details with the PGP key
   referenced there if possible.

When reporting, please include as much of the following as you can:

- The affected version(s) and environment (ImapFlow version, Node.js version,
  OS).
- The component involved (e.g. the IMAP response stream/parser, literal and line
  handling, TLS/STARTTLS upgrade, credential handling, the command compiler, or
  the public client API).
- A clear description of the issue and its impact (e.g. memory exhaustion or
  denial of service from a malicious server, parser crash, credential
  disclosure, TLS verification bypass, injection into the IMAP command stream,
  prototype pollution, information disclosure).
- A minimal proof of concept or reproduction steps - ideally a sample server
  response or a short script that triggers the issue.
- Any suggested remediation, if you have one.

We are a small team, so there is no guaranteed response time - sometimes reports
are handled within hours, sometimes they take longer. Accepted issues are fixed
in a new release and coordinated through a GitHub Security Advisory, and
reporters who wish to be named are credited.

## CVEs

We track and disclose vulnerabilities through GitHub Security Advisories. We do
not request or manage CVE identifiers ourselves. If you need a CVE assigned for a
reported issue, please request one yourself - for example, through GitHub's own
CVE request flow on the published advisory, or another CNA.

## Scope

In scope: the ImapFlow library source in this repository - the IMAP response
stream and token parser (including handling of hostile or malformed server
responses, literals, line lengths, and resource/DoS bounds), the TLS and
STARTTLS upgrade path and certificate handling, credential handling during
authentication, the command compiler that builds outgoing IMAP commands, and the
public client API.

Out of scope:

- Vulnerabilities in your own application code that uses ImapFlow.
- Misconfiguration of your usage - for example, disabling TLS certificate
  verification (`tls.rejectUnauthorized: false`), connecting over cleartext when
  TLS is available, or passing untrusted input directly into mailbox paths or
  command arguments without validation.
- Vulnerabilities in the IMAP servers you connect to, or in third-party
  dependencies (please report those to their respective maintainers; we will
  upgrade once a fix is available).
- Issues that require an already-compromised host or local access to the machine
  running ImapFlow.
- Social-engineering reports and theoretical issues without a demonstrated,
  concrete impact.

Thank you for helping keep ImapFlow and its users safe.
