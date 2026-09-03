# Tools

Eleven tools: six read, five write. The write tools are **not registered** unless
`IMAP_READ_ONLY=false` — and it defaults to `true`, so an unconfigured server offers
the six read tools alone.

Beyond that, `IMAP_ALLOW_TOOLS` and `IMAP_DENY_TOOLS` narrow the list further, and
`IMAP_ALLOW_TOOLS=essential` selects the six marked **essential** below — see
[choosing the tools that load](/guide/configuration#choosing-the-tools-that-load).

## Read tools

Registered always.

| Tool                | Description                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `list_mailboxes`    | The folder tree, with the special-use flags the server reports (`\Drafts`, `\Sent`, …). **essential**     |
| `list_new_messages` | What the assistant has not seen yet, tracked with its own IMAP keyword rather than `\Seen`. **essential** |
| `list_messages`     | Search and list a mailbox: by sender, subject, date range, flags. **essential**                           |
| `get_message`       | One message, body fenced as untrusted content. **essential**                                             |
| `get_attachments`   | Attachment metadata, and small ones inline within the size and type caps                                 |
| `get_server_info`   | Capabilities, the mailbox in use, and whether the write tools are registered                             |

## Write tools

Registered only when `IMAP_READ_ONLY=false`.

| Tool                   | Description                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `set_message_flags`    | Set or clear flags and keywords — read, flagged, and the assistant's own. **essential**  |
| `move_messages` 👤     | Move or copy messages between folders. **essential**                                     |
| `delete_messages` 👤   | Delete: sets `\Deleted` and expunges. Not the same as moving to Trash                    |
| `save_draft`           | Append a draft to the drafts folder. This server never **sends** anything                |
| `manage_mailbox` 👤    | Create, rename and delete folders — 👤 for `delete`, 🔒 for `rename`, nothing for `create` |

👤 **asks a person** through MCP elicitation, a dialog the model cannot answer on its
behalf. 🔒 uses the two-call `confirm_token` only. Where a 👤 tool's client cannot show
a dialog it falls back to 🔒, and `ELICITATION=false` takes that fallback deliberately.
See [Asking a person](/guide/approval).

Every tool declares an `outputSchema` and answers with `structuredContent` beside
the text block, so a client can use a result without parsing prose. Every tool
that reports anything out of the mailbox carries `untrusted: true` and
`source: "imap"` as fields — only `get_server_info` and the five write tools are
without it. `get_message` and a text attachment keep the nonce fence in the text
block and state the same fields in the structured half; an image attachment
keeps its bytes in the content block rather than repeating the base64.

Every tool declares all four MCP annotations — `readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint`. `get_attachments` carries the only *computed* one in
the family: it is `readOnlyHint: true` until `IMAP_DOWNLOAD_DIR` is set, because from
then on it writes files.

## Resources, which the filter does not cover

Attachments are also exposed as MCP **resources**. `IMAP_ALLOW_TOOLS` narrows
`tools/list`, not `resources/list`, so a filtered server still serves those.
`IMAP_DOWNLOAD_DIR` and the attachment type allowlist are what constrain them.
