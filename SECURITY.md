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

The hidden-HTML pass is best effort, deliberately so. It is regex-based with bounded scan
windows (an unbounded scan over crafted HTML is a CPU-exhaustion primitive), which means an
element hidden inside a nested same-name tag, hidden via a stylesheet class, or larger than the
window survives it. That is acceptable because nothing downstream trusts the stripping: whatever
gets through still arrives inside the fence, marked line by line as untrusted.

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
exactly the wrong moment.

## Attachments

Attachments pass a declaration check — content-type allowlist, executable-extension refusal,
size ceiling — and then a magic-byte check on the bytes themselves. The second one is the one
that cannot be lied to: a Windows executable renamed `invoice.pdf` and declared
`application/pdf` clears every other gate and fails there. The same applies when writing to
disk, where a disguised binary is more dangerous than in a transcript, not less.

Writing to disk happens only when `IMAP_DOWNLOAD_DIR` is set. The directory comes solely from
that variable, never from a tool argument; filenames are stripped of separators and directional
overrides; the resolved path is checked against the directory again; and the file is opened with
`wx` and mode `0600`, so an existing file is never overwritten and a symlink planted under a
predictable attachment name is never followed.

Images are returned as images, with a warning. Text rendered inside a picture is still text a
stranger wrote, and no amount of sanitising reaches it — the warning is the only honest answer.
