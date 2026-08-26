# imap-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for ordinary mailboxes.
It speaks IMAP, so it works with any provider rather than one vendor's API: read and search
mail, organise it, save attachments, and draft replies.

Eleven tools, not fifty. A mail account is a workflow, not an API surface, and a model picks
the right tool far more reliably from a short list — so related operations are folded into one
tool with a mode rather than split across many.

## What makes it different

**It cannot send mail. That is the feature.** An agent with access to private data, exposure to
untrusted content, and a channel to the outside world is exploitable by anyone who can put a
message in the inbox — the pattern that produced
[EchoLeak](https://msrc.microsoft.com/update-guide/vulnerability/CVE-2025-32711), where one
crafted email exfiltrated internal data from Microsoft 365 Copilot with no user interaction.
This server has the first two and deliberately not the third. `save_draft` writes the reply
into your Drafts folder; you send it from your own mail client. No amount of clever text in a
message can make this server post anything anywhere.

**Writes are off until you turn them on.** With only `IMAP_HOST`, `IMAP_USER` and
`IMAP_PASSWORD` set, the server registers six read tools and nothing else. The mailbox tools
appear with `IMAP_ALLOW_WRITE=true`. Tools that are off are not registered at all — a
capability the model cannot see is one it cannot be talked into using.

**Mail is treated as hostile input, because it is.** Anyone in the world can put text in your
inbox. Message bodies are fenced between markers carrying a per-call random nonce, _and_ every
line inside them is prefixed with that nonce, so the "this is data" signal does not stop at the
edges of a long forwarded thread. A reminder follows the block, because otherwise the last
instruction-shaped sentence in the model's context is the attacker's. Hidden HTML, zero-width
characters and directional overrides are stripped before the model sees anything, and markdown
image syntax is defused so a rendering client cannot be made to fetch a tracking URL.

Alongside the message you get a server-side assessment: the SPF/DKIM/DMARC verdicts, which
prompt-injection shapes matched, and which words mix Latin with Cyrillic or Greek letters. When
something matches, the warning is the first thing in the result rather than a field buried in
JSON.

**"New mail" that actually works.** The server tags messages it has handed over with a custom
IMAP keyword (`AiSeen` by default), so `list_new_messages` returns each message once. The human
`\Seen` state is never touched — everything is read with `BODY.PEEK`.

**Deleting asks a person.** Where the client supports MCP elicitation, `delete_messages` and
deleting a folder raise a real dialog that the model cannot answer on its behalf. Where it does
not, they fall back to a two-call token — and say so, rather than implying somebody approved.

## Requirements

- Node.js 22 or newer
- An IMAP account. Providers with two-factor authentication generally need an app-specific
  password.

## Configuration

| Variable                    | Required | Default       | Description                                          |
| --------------------------- | -------- | ------------- | ---------------------------------------------------- |
| `IMAP_HOST`                 | yes      | —             | Hostname of the IMAP server, e.g. `imap.example.net` |
| `IMAP_USER`                 | yes      | —             | Account username, usually the address                |
| `IMAP_PASSWORD`             | yes      | —             | Password or app-specific password                    |
| `IMAP_PORT`                 | no       | `993` / `143` | Defaults by TLS mode                                 |
| `IMAP_TLS`                  | no       | `implicit`    | `implicit`, `starttls` or `none`                     |
| `IMAP_MAILBOX`              | no       | `INBOX`       | Mailbox the message tools default to                 |
| `IMAP_ALLOW_WRITE`          | no       | `false`       | Exactly `true` registers the five mailbox tools      |
| `IMAP_SEEN_KEYWORD`         | no       | `AiSeen`      | Keyword for new-mail tracking; empty turns it off    |
| `IMAP_DRAFTS_MAILBOX`       | no       | auto          | Overrides the folder found via the `\Drafts` flag    |
| `IMAP_MAX_MESSAGES`         | no       | `100`         | Default page size                                    |
| `IMAP_MAX_ATTACHMENT_BYTES` | no       | `1048576`     | Ceiling for returning an attachment inline           |
| `IMAP_MAX_DOWNLOAD_BYTES`   | no       | `26214400`    | Ceiling for writing one to disk                      |
| `IMAP_ATTACHMENT_TYPES`     | no       | see below     | Comma-separated content-type allowlist               |
| `IMAP_DOWNLOAD_DIR`         | no       | —             | Setting it allows saving attachments there           |
| `IMAP_INSECURE_TLS`         | no       | `false`       | Exactly `true` accepts a self-signed certificate     |

Booleans are compared against the literal string `true`; `1`, `yes` and `True` are not true.
The password is deleted from the process environment as soon as it is read, so it is not
visible to child processes or in `/proc/<pid>/environ`.

Without `IMAP_DOWNLOAD_DIR` this server never writes to the filesystem. The two size limits are
separate on purpose: one protects the model's context window, the other protects your disk.

The server starts without credentials on purpose — it completes the handshake and lists its
tools, and every call then fails with setup instructions instead of reaching a server.

## Tools

**Read** — always registered

| Tool                | What it does                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `get_server_info`   | Capabilities, permanent flags, whether the keyword is storable, which tool groups are on |
| `list_mailboxes`    | Every folder with message and unseen counts and its special-use role                     |
| `list_messages`     | Lists and searches: sender, recipient, subject, body, date range, flags                  |
| `list_new_messages` | Messages not handed over yet; marks them afterwards, `dry_run` to preview                |
| `get_message`       | Headers and body, fenced untrusted, plus the security assessment; `include_thread`       |
| `get_attachments`   | Without `part_id` lists them, with `part_id` reads or saves one                          |

**Mailbox** — needs `IMAP_ALLOW_WRITE=true`

| Tool                | Confirmation                                        |
| ------------------- | --------------------------------------------------- |
| `set_message_flags` | none — flags are reversible                         |
| `move_messages`     | 🔒 for `move`, none for `copy`                      |
| `delete_messages`   | 👤 asks the user, 🔒 where the client cannot        |
| `manage_mailbox`    | 👤 for `delete`, 🔒 for `rename`, none for `create` |
| `save_draft`        | none — a draft does not leave the mailbox           |

👤 raises a dialog the model cannot answer · 🔒 needs a confirmation token: call once to
receive one, then again with it.

Attachments are also available as MCP resources at `imap://message/{uid}/part/{partId}`, which
matters where the server has no useful filesystem. The resource path runs the same allowlist,
size limit and magic-byte check as the tool — it is not a second, unguarded door.

## Not exposed, on purpose

No sending, no SMTP, no raw IMAP passthrough, no `APPEND` of arbitrary MIME, no HTML
composition, no OAuth2. The first is the whole security argument (see `SECURITY.md`); the
second would make every guard here optional; the last is planned but needs a test account
before it ships.

## Safety

- **Every result carrying mailbox content is marked untrusted**, message bodies additionally
  fenced with a per-call nonce and marked line by line.
- **Attachments pass two independent gates.** The declaration is checked against a
  content-type allowlist, an executable-extension refusal list and a size ceiling; the bytes
  are then checked against magic numbers. An executable renamed to `.pdf` and declared
  `application/pdf` clears every declaration check and fails on its bytes — including when
  saving to disk, where it would be more dangerous, not less.
- **A `part_id` must come from a listing call**, so the body cannot be pulled out through the
  attachment tool and escape its framing.
- **Downloads cannot escape their directory.** The target comes only from the environment, the
  filename is sanitised, the resolved path is re-checked, and the file is opened with `wx` and
  mode `0600` — so nothing is overwritten and no planted symlink is followed.
- **Mailbox names, flags and addresses are refused if they contain line breaks.** IMAP is a
  line protocol and a draft is a mail header; a CR is an injection primitive, not a typo.
- **TLS is never disabled globally.** `IMAP_INSECURE_TLS` is scoped to the connection it names;
  `NODE_TLS_REJECT_UNAUTHORIZED` appears nowhere.
- **Every change to the mailbox is logged to stderr** with the UIDs and folder — never the
  subject. stderr is the one channel the model does not read.
- **Responses are bounded.** Whole items are dropped rather than the JSON being sliced, and the
  truncation notice comes first so the recovery hint survives.

`SECURITY.md` has the trust model, what these measures do _not_ cover, and how to report a
vulnerability.

## Development

```bash
npm install
npm test
npm run build
```

## License

MIT
