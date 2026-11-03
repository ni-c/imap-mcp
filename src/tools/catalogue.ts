/**
 * The tools this server can register, declared rather than discovered.
 *
 * Declared, because the tool filter has to answer "is this a name you have?"
 * *before* anything is registered — and in read-only mode the write tools are
 * never registered at all. Deriving the catalogue from what actually reached
 * `registerTool` would make `IMAP_ALLOW_TOOLS=delete_messages` report "unknown
 * tool" under `IMAP_READ_ONLY=true`, which is the one answer that is wrong.
 *
 * This is also the full tool surface, hard-coded on purpose: a tool that appears
 * or disappears by accident is a change to the server's contract and has to be a
 * deliberate edit here. `test/tool-filter.test.ts` asserts that these lists and
 * the tools the server really registers are the same set.
 *
 * Note this covers *tools* only. This server also registers attachment
 * resources (`src/resources.ts`), and the filter does not touch those.
 */

/**
 * Registered always — but "read" here means "registered under the read-only
 * default", not "touches nothing".
 *
 * Two of them do write, and an operator who reads `IMAP_READ_ONLY=true` as
 * "never changes anything" would be wrong about both. `list_new_messages`
 * issues a STORE to set the seen keyword, which is how it can answer "anything
 * new?" at all — that is the deliberate trade, and `dry_run` previews it
 * without marking. `get_attachments` creates files when `IMAP_DOWNLOAD_DIR` is
 * set. Neither carries `readOnlyHint: true`; the other four do.
 */
export const READ_TOOLS = [
  'get_attachments',
  'get_message',
  'get_server_info',
  'list_mailboxes',
  'list_messages',
  'list_new_messages',
] as const;

/** Registered only when `IMAP_READ_ONLY` is turned off. */
export const WRITE_TOOLS = [
  'delete_messages',
  'manage_mailbox',
  'move_messages',
  'save_draft',
  'set_message_flags',
] as const;

/** Every tool, read-only mode aside. */
export const ALL_TOOLS: readonly string[] = [...READ_TOOLS, ...WRITE_TOOLS];

/**
 * What `IMAP_ALLOW_TOOLS=essential` selects: find the mail, read it, file it.
 *
 * Six of eleven. Left out on purpose: `delete_messages` (irreversible),
 * `save_draft` (composing is a different job from triage), `get_attachments`
 * (large payloads, and the attachment resources cover the same ground), and
 * `get_server_info` and `manage_mailbox`, which are administrative.
 *
 * Four of the six are read tools, so `IMAP_ALLOW_TOOLS=essential` remains a
 * working combination under the default `IMAP_READ_ONLY=true` — it then yields
 * exactly those four.
 */
export const ESSENTIAL_TOOLS: readonly string[] = [
  'list_mailboxes',
  'list_new_messages',
  'list_messages',
  'get_message',
  'set_message_flags',
  'move_messages',
];

/** Whether a tool is registered when `IMAP_SEEN_KEYWORD` is empty. */
const registeredWithoutKeyword = (name: string) => name !== 'list_new_messages';

/**
 * The catalogue for this configuration: the names the server will really
 * register, not all the names it knows.
 *
 * `list_new_messages` is registered only while `IMAP_SEEN_KEYWORD` is not
 * empty (it has nothing to mark new mail with otherwise). A catalogue that
 * still listed it would let `IMAP_ALLOW_TOOLS=list_new_messages` through the
 * filter and then register nothing, and would count it in `essential`, which
 * then yields one tool fewer than the set it names. Without it the filter
 * answers an explicit request for the tool the way it answers any name it does
 * not have: loudly, at start-up, with the names that exist.
 */
export function catalogueFor(seenKeyword: string): {
  all: readonly string[];
  essential: readonly string[];
  ungated: readonly string[];
} {
  if (seenKeyword !== '') {
    return { all: ALL_TOOLS, essential: ESSENTIAL_TOOLS, ungated: READ_TOOLS };
  }
  return {
    all: ALL_TOOLS.filter(registeredWithoutKeyword),
    essential: ESSENTIAL_TOOLS.filter(registeredWithoutKeyword),
    ungated: READ_TOOLS.filter(registeredWithoutKeyword),
  };
}
