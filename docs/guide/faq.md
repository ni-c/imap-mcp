# FAQ & troubleshooting

<!-- Keep this entry. "A tool is missing" is the one question the tool filter
     creates, and the answer people reach for first — a bug — is the wrong one. -->

## One tool I expected is missing

Something narrowed the list. In order of likelihood:

- `IMAP_READ_ONLY` is set, and it is a write tool.
- `IMAP_ALLOW_TOOLS` is set and does not name it — it is an allow list, so
  anything not named is out.
- `IMAP_DENY_TOOLS` names it, possibly through a prefix such as `delete_*`.

A filtered tool is not registered at all, so it is missing from `tools/list` and
answers `tools/call` with "tool not found" — the same as a write tool under
read-only. There is no state where it is hidden but still callable.

What it is _not_ is a typo in one of those variables: an entry that matches no tool
stops the server at startup and says which entry it was. See
[choosing the tools that load](/guide/configuration#choosing-the-tools-that-load).

## A search fails with "timed out after 30 seconds"

The mail server took longer than this server gives one IMAP command. If it is slow
rather than unreachable — a `body` search over a large folder is the usual case —
raise `IMAP_COMMAND_TIMEOUT_SECONDS`, and check your client's own deadline first; see
[slow servers](/guide/configuration#slow-servers). If even a small folder times out,
the server is not answering, and more time will not help.
