# Contributing

Thanks for taking the time. Small, focused changes with tests land fastest.

## Development setup

```sh
git clone https://github.com/ni-c/imap-mcp.git && cd imap-mcp
npm install
npm test          # 400+ tests against an in-memory IMAP fake, no network
npm run build
```

A minimal dev environment — a throwaway IMAP server you can safely write to:

```sh
docker run --rm -p 3143:3143 -p 3025:3025 \
  -e GREENMAIL_OPTS='-Dgreenmail.setup.test.all -Dgreenmail.users=demo:demo@example.net -Dgreenmail.verbose' \
  greenmail/standalone:latest

IMAP_HOST=127.0.0.1 IMAP_PORT=3143 IMAP_TLS=none \
IMAP_USER=demo IMAP_PASSWORD=demo \
npx @modelcontextprotocol/inspector node dist/index.js
```

Never point a development run at a mailbox you care about. `IMAP_READ_ONLY`
defaults to `true`, but the whole point of testing the write tools is turning
that off.

## Expectations

- **Tests.** Behaviour changes come with a test that fails without the change.
  CI runs lint, build and the full suite on Node 22 and 24, plus `npm audit`,
  CodeQL and a Trivy scan of the container image.
- **Comments** explain constraints the code cannot show — not what the next line does.
- **Security-sensitive areas** (config parsing, confirmation tokens, the untrusted-content
  fencing, attachment gates, anything that builds an IMAP command or a mail header):
  please describe the attack you are defending against, or the one your change might
  open, in the PR text.
- **The server must not gain the ability to send mail.** That absence is the security
  argument this project rests on; a patch adding SMTP will be declined regardless of how
  it is written. `save_draft` writing into the Drafts folder is the supported shape.
- **Mail is untrusted input.** Anything that puts message content into a tool result has
  to keep it inside the nonce fencing, and anything that puts message content into text a
  model treats as instruction — a confirmation prompt, an error message — is a bug.
- **No new runtime dependencies** without a very good reason; the small tree is a
  feature.
- Run `npm run lint` before pushing — it checks both oxlint and prettier, and prettier
  also validates the YAML, JSON and Markdown files.

## Questions and bugs

- Questions and ideas → [Discussions](https://github.com/ni-c/imap-mcp/discussions)
- Reproducible problems → [Issues](https://github.com/ni-c/imap-mcp/issues)
- Vulnerabilities → [private reporting](https://github.com/ni-c/imap-mcp/security/advisories/new),
  never a public issue — see [SECURITY.md](SECURITY.md)
