# Security policy

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/ni-c/imap-mcp/security/advisories/new).
Do not open a public issue for an unpatched vulnerability, and do not include real credentials,
tokens, hostnames or private configuration in a report.

You can expect an initial response within a week. Fixed vulnerabilities are published as a new
release with a note in the CHANGELOG.

## Supported versions

Only the latest release and the current `main` branch receive security fixes.

## Trust model

The credentials this server holds are the mailbox itself. Anyone who obtains them can read
every message the account has ever received — which for most accounts includes password reset
links, invoices, contracts and two-factor codes. Treat `IMAP_PASSWORD` accordingly, prefer an
app-specific password over the account password, and prefer a dedicated account over a personal
one.

Treat every environment variable this server reads as a secret. The MCP client process, and
therefore the model driving it, sees every tool result — do not point this server at a mailbox
whose contents you would not put in a model's context.

## Why there is no send tool

An agent is exploitable by indirect prompt injection when three things are true at once: it can
reach private data, it processes content an attacker controls, and it can send data somewhere.
A mailbox supplies the first two by definition — anyone who knows the address can put text in
it. So the third is the one that can be removed, and removing it is worth more than any amount
of filtering.

This is not hypothetical. [EchoLeak](https://msrc.microsoft.com/update-guide/vulnerability/CVE-2025-32711)
(CVE-2025-32711, CVSS 9.3) was a zero-click attack on Microsoft 365 Copilot: a single crafted
email, never opened by the user, caused internal data to be exfiltrated to an attacker's server
during ordinary background processing.

So this server has no SMTP client, no send tool and no way to make an outbound request of any
kind. `save_draft` writes into the mailbox it already has open; the message then sits in Drafts
until a person opens their own mail client and sends it. The human's mail client is the gate,
and it is a gate no text in a message can talk its way past.

**What this does not cover.** The property holds for _this server_, not for the session it runs
in. If the same agent also has a web-fetch tool, a shell, or another MCP server that can post
somewhere, the three conditions are satisfied again at the session level and mail read through
this server can be exfiltrated through that other tool. Nothing here can prevent that; all this
server can do is stop being the third ingredient. Compose accordingly.

## Untrusted content

Message bodies are returned between markers carrying a per-call random nonce, and every line
inside is prefixed with that nonce. Text written before the call cannot predict either, so a
message cannot close the block early and continue in the server's voice. A reminder follows the
block, because without one the last instruction-shaped sentence in the model's context is the
attacker's.

Before that, the text is normalised: hidden HTML elements are dropped, zero-width and
directional-override characters removed, and markdown image syntax — inline, reference and
shortcut style — defused so a rendering client cannot be induced to fetch a URL carrying data
in its query string.

The hidden-HTML pass is best effort, deliberately so. An element hidden inside a nested same-name
tag, hidden via a stylesheet class, or larger than the removal window survives it. That is
acceptable because nothing downstream trusts the stripping: whatever gets through still arrives
inside the fence, marked line by line as untrusted.

It is also a **single forward pass**, and that part is not a matter of taste. This section used to
claim the pass was safe because its scan windows were bounded. They were, and it wasn't: bounding
how far one removal may scan bounds one factor of a product whose other factor is how many
removals an input can start. A body of `'<style '` repeated 73 000 times is 512 000 legal bytes
that start 73 000 bounded scans and finish none of them, and the regex chain that used to sit here
took **33 seconds** on it — on a single-threaded process whose transport is stdio, so the whole
server, not just that call. The command timeout could not help: it wraps IMAP commands, not
parsing, and a `setTimeout` cannot fire on a blocked event loop. Reachable with one ordinary mail
that has a `text/html` part and no `text/plain` one, and again through a `text/html` attachment.
The pass now walks the input once with cursors that never rewind, plus one global budget for the
searches that look for a closing tag, so the number of start tokens no longer multiplies anything.
The same input is now under 20 ms.

**Folder names are mailbox content too.** On a shared account, a public namespace or any mailbox
somebody else can create a folder in, the name is chosen by whoever created it — and it reaches the
model through `list_mailboxes` long before anyone opens a message. It used to reach it raw: not
`sanitizeText`, not `sanitizeFilename`, nothing. So `list_mailboxes` now returns two strings per
folder. `path` is verbatim, because it is the argument every other tool takes and a cleaned-up copy
would name a folder the server does not have; `display_name` is the copy that is safe to read and
to quote, and where the two differ the entry says so and spells out the difference. The mailbox
parameter refuses C0/C1 control characters outright. It does not refuse zero-width or
directional-override characters: a folder with those in its name exists, and a parameter that
rejected it would leave it unreadable and undeletable through this server.

**Results have a stated size and now keep to it.** `MAX_RESULT_BYTES` used to be enforced only where
a result was JSON. Everything else grows on the way out — defusing an image rewrites four characters
into forty-four, the per-line datamarks add ten characters a line, and a thread listing carries up
to fifty subjects and address lists the senders chose. `get_message(include_thread: true)` came to
570 000 characters against a stated 200 000. The check now runs on the assembled text.

The SPF/DKIM/DMARC verdicts are read from the topmost `Authentication-Results` header only —
a receiving server that adds one prepends it — and come with the authserv-id and a `forgeable`
flag. Senders can include such a header themselves, and not every receiving server filters
inbound copies; when the authserv-id cannot be related to the account's own domain, the flag
says so rather than letting a forged "pass" read like the real thing.

The injection patterns the server recognises are reported as a **signal**, never used to drop a
message silently. A filter that appeared to work would be an argument for trusting whatever got
through, which is precisely the wrong conclusion: an attacker who can iterate will find a
phrasing the patterns do not match.

**Be clear about what framing buys.** Measured across models, delimiting untrusted content
takes resistance to injection from roughly 61% to roughly 90% — a real improvement, and nowhere
near a guarantee, with the weakest models benefiting least. Against an attacker who adapts to
the defence, prompt-level measures fail. They are a speed bump. The architecture above is the
wall.

## Confirmation

Deleting messages, moving or copying them, and deleting a folder ask the person at the
keyboard, using MCP elicitation.
That matters because the older mechanism — returning a token the caller must send back — is
**not** a human-in-the-loop gate: the token appears in a tool result, so the model reads it and
can call again in the same turn without anyone seeing anything. It still prevents a target set
from being widened between the two calls, which is why it remains the fallback where a client
cannot show a dialog, and why the result says so plainly instead of implying an approval that
did not happen.

Tokens are random, single-use, expire after five minutes, and are bound to a SHA-256
fingerprint of the sorted target set: a confirmation obtained for one message cannot be
replayed for a longer list.

`ELICITATION=false` moves a capable client onto that fallback deliberately, for a scheduled
job or a test harness. It does not remove the guard — there is no setting in which a guarded
call goes unannounced — and the server prints one line at startup saying it is off.

Confirmation text never quotes a subject, sender or body. That text is read by a human and by a
model, and putting attacker-chosen prose into it would hand the attacker the last word at
exactly the wrong moment. A folder name has to appear — it is what the person is deciding about —
so it appears on its own labelled line, with its invisible characters removed and spelled out
beside it. `Archive` and `Archive<U+200B>` are the same pixels; a dialog that renders the second
one verbatim asks about the folder the reader recognises and acts on the one they do not.

### What a confirmation binds

An approval here binds an answer to **this question**, not to **this moment**. The sealed state
carries the resource key — the operation plus a fingerprint of the exact target set — and the
library verifies both. It does not carry a nonce that is spent on use, so within its fifteen-minute
lifetime the same sealed state and the same accepted answer would prove the same thing twice. That
is binding, not freshness.

On this server the gap is not reachable today, and the reason is worth writing down because it is
a property of the deployment rather than of the code above:

- `src/index.ts` connects an `McpServer` to a `StdioServerTransport` directly. It does not pass
  `supportedProtocolVersions`, and the SDK's default list ends at `2025-11-25`. A client that asks
  for `2026-07-28` is answered `2025-11-25`, and `server/discover` is not registered at all.
- On `2025-11-25` the question never crosses the wire. The SDK's legacy shim turns the returned
  `input_required` into the elicitation request it used to be, waits for the reply and resumes
  **inside the same `tools/call`**. There is no round trip for a caller to repeat, because there is
  no state handed out.
- The two-call token — the fallback for clients that cannot show a dialog — is single-use and
  spent by `consume`, so it has freshness already.

What would have to be built on the day this server speaks the newer revision, and only then: the
sealed state would need a use-once marker checked and burned server-side, so that a replayed
`requestState` with a replayed accepted answer is refused rather than honoured. Until the server
offers `2026-07-28` there is nothing to burn, and a mechanism guarding a path that does not exist
is a mechanism nobody maintains.

## Attachments

Attachments pass a declaration check — content-type allowlist, executable-extension refusal,
size ceiling — and then a magic-byte check on the bytes themselves. The second one is the one
that cannot be lied to: a Windows executable renamed `invoice.pdf` and declared
`application/pdf` clears every other gate and fails there. The same applies when writing to
disk, where a disguised binary is more dangerous than in a transcript, not less.

The extension refusal is only as long as the extractor that feeds it. `appref-ms` and `application`
sat in the blocklist while the pattern reading an extension out of a filename accepted neither a
hyphen nor eleven characters, so both read as no extension at all — which makes the check skip
rather than fail. A ClickOnce manifest declared `application/xml` is valid XML by every check that
looks at bytes, so nothing else stopped it. A test now walks the whole blocklist and requires each
entry to be refused, because two declarations that have to agree do not announce when they stop
agreeing.

Writing to disk happens only when `IMAP_DOWNLOAD_DIR` is set. The directory comes solely from
that variable, never from a tool argument; filenames are stripped of separators and directional
overrides; the resolved path is checked against the directory again; and the file is opened with
`wx` and mode `0600`, so an existing file is never overwritten and a symlink planted under a
predictable attachment name is never followed.

Images are returned as images, with a warning. Text rendered inside a picture is still text a
stranger wrote, and no amount of sanitising reaches it — the warning is the only honest answer.
