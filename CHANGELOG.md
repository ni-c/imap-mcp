# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- The release workflow extracts the section of the version being tagged with awk,
     matching "## [x.y.z]". Keep that heading shape exactly. -->

<!-- The docs site includes everything between these markers. Keep the end marker
     last in the file so the link definitions come along. -->
<!-- #region changelog -->

## [Unreleased]

### Changed

- The SPF/DKIM/DMARC verdicts are now read from the topmost
  `Authentication-Results` header only and come with the authserv-id and a
  `forgeable` flag, so a header the sender wrote themselves cannot present a
  forged "pass" as the receiving server's verdict.
- Thread subjects and sender names in the `get_message` metadata block are now
  named as sender-chosen in its caveat, and the injection-shape detection runs
  over the metadata block too, not only over the message body.
- `get_attachments` no longer advertises `readOnlyHint: true` when
  `IMAP_DOWNLOAD_DIR` is set — with a download directory configured it can
  create files, and clients that auto-approve read-only tools should ask.
- Reference- and shortcut-style markdown images (`![alt][id]`, `![id]`) are
  defused alongside the inline form.
- The HTML-stripping passes use bounded scan windows, so crafted HTML full of
  unclosed tags can no longer burn minutes of CPU; hidden elements larger than
  the window are left to the fencing, which was always the real defence.
- A long `References` chain in a draft is folded across lines instead of
  emitting a header line beyond the RFC 5322 998-octet limit.
- Confirmation tokens are compared in constant time.
- `IMAP_HOST` no longer accepts a colon outside an IPv6 address, matching what
  the error message always said.
- The inline image result uses the allowlist-checked declared content type
  rather than the unchecked one from the download metadata.

## [0.1.0] - 2026-08-24

### Added

- Initial release: MCP server for IMAP mailboxes.
- Six read tools, always available: `get_server_info`, `list_mailboxes`,
  `list_messages`, `list_new_messages`, `get_message`, `get_attachments`.
- Five mailbox tools behind `IMAP_ALLOW_WRITE=true`: `set_message_flags`,
  `move_messages`, `delete_messages`, `manage_mailbox`, `save_draft`.
- **No way to send mail, by design.** Private data plus untrusted content plus an
  outbound channel is what makes an agent exploitable by indirect prompt
  injection; a mailbox supplies the first two, so this server does without the
  third. `save_draft` stores the reply for a person to send from their own client.
- New-mail tracking through a custom IMAP keyword, so an agent sees each message
  once without touching the human read state.
- Message bodies are fenced with a per-call random nonce and marked line by line,
  followed by a reminder, so the provenance signal does not stop at the edges of a
  long thread and the attacker does not get the last word.
- Hidden HTML, zero-width characters and directional overrides are stripped, and
  markdown image syntax is defused so a rendering client cannot be induced to
  fetch a tracking URL.
- Each message comes with a server-side assessment: SPF/DKIM/DMARC verdicts,
  matching prompt-injection shapes and mixed-script words. A match puts the
  warning at the top of the result rather than inside the metadata.
- Deleting messages and deleting a folder ask the user through MCP elicitation
  where the client supports it, falling back to a two-call token where it does
  not — and saying which of the two happened.
- Attachments can be read inline, written to `IMAP_DOWNLOAD_DIR` or fetched as MCP
  resources. All three paths share one policy: content-type allowlist,
  executable refusal, size ceiling and a magic-byte check on the bytes.
- Every change to the mailbox is logged to stderr with UIDs and folder, never
  subjects.

[0.1.0]: https://github.com/ni-c/imap-mcp/releases/tag/v0.1.0

<!-- #endregion changelog -->
