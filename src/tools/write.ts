import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { requestApproval } from '../approval.js';
import { audit } from '../audit.js';
import type { Config } from '../config.js';
import {
  confirmationPrompt,
  setResourceKey,
  type ConfirmationStore,
} from '../confirm.js';
import { ToolInputError } from '../errors.js';
import { ImapClient, withTimeout } from '../imap.js';
import { buildDraft } from '../draft.js';
import { jsonResult, run, textResult } from '../result.js';
import {
  addressListParam,
  confirmTokenParam,
  flagListParam,
  mailboxParam,
  optionalMailboxParam,
  uidListParam,
  uidParam,
} from '../schema.js';

export function registerWriteTools(
  server: McpServer,
  client: ImapClient,
  config: Config,
  confirmations: ConfirmationStore
): void {
  server.registerTool(
    'set_message_flags',
    {
      title: 'Add or remove message flags',
      description:
        'Adds or removes IMAP flags and keywords on one or more messages: ' +
        '\\Seen to mark read or unread, \\Flagged to star, \\Answered, \\Draft, ' +
        'or any custom keyword the server accepts. Reversible, so no ' +
        'confirmation is required. Removing the new-mail keyword makes those ' +
        'messages show up in list_new_messages again.',
      inputSchema: {
        uids: uidListParam,
        mailbox: optionalMailboxParam,
        add: flagListParam.optional().describe('Flags or keywords to set.'),
        remove: flagListParam
          .optional()
          .describe('Flags or keywords to clear.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ uids, mailbox, add, remove }) =>
      run(async () => {
        if (add === undefined && remove === undefined) {
          throw new ToolInputError(
            'imap-mcp: give at least one of "add" or "remove".'
          );
        }
        return client.withMailbox(mailbox, false, async (connection) => {
          if (add !== undefined) {
            await withTimeout(
              connection.messageFlagsAdd(uids, add, { uid: true }),
              'STORE'
            );
          }
          if (remove !== undefined) {
            await withTimeout(
              connection.messageFlagsRemove(uids, remove, { uid: true }),
              'STORE'
            );
          }
          const source = mailbox ?? client.defaultMailbox;
          audit('set_flags', {
            mailbox: source,
            uids,
            added: add,
            removed: remove,
          });
          return jsonResult({
            mailbox: source,
            uids,
            added: add ?? [],
            removed: remove ?? [],
          });
        });
      })
  );

  server.registerTool(
    'move_messages',
    {
      title: 'Move or copy messages',
      description:
        'Moves messages to another mailbox, or copies them when mode is ' +
        '"copy". Moving requires confirmation: call once to receive a token, ' +
        'then again with that token and the same UID list. Copying does not, ' +
        'because nothing is removed.',
      inputSchema: {
        uids: uidListParam,
        destination: mailboxParam.describe(
          'Mailbox the messages end up in, exactly as listed by list_mailboxes.'
        ),
        mailbox: optionalMailboxParam,
        mode: z
          .enum(['move', 'copy'])
          .optional()
          .describe(
            '"move" (default) removes the originals, "copy" keeps them.'
          ),
        confirm_token: confirmTokenParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ uids, destination, mailbox, mode, confirm_token }) =>
      run(async () => {
        const copying = mode === 'copy';
        const source = mailbox ?? client.defaultMailbox;
        if (!copying) {
          // The key covers the exact UID set: a confirmation for [1] must not
          // execute [1, 2], where the model picked the second list. A move is
          // reversible, so this stays on the token rather than interrupting the
          // user with a dialog for every tidy-up.
          const key = setResourceKey(
            `move_messages:${source}:${destination}`,
            uids.map(String)
          );
          if (!confirmations.consume(key, confirm_token)) {
            return textResult(
              confirmationPrompt(
                `move ${uids.length} message(s) from "${source}" to "${destination}"`,
                confirmations.issue(key),
                confirmations.ttlMinutes,
                'The messages keep their content but get new UIDs, so the current ones stop working.'
              )
            );
          }
        }
        return client.withMailbox(mailbox, false, async (connection) => {
          if (copying) {
            await withTimeout(
              connection.messageCopy(uids, destination, { uid: true }),
              'COPY'
            );
          } else {
            await withTimeout(
              connection.messageMove(uids, destination, { uid: true }),
              'MOVE'
            );
          }
          audit(copying ? 'copy' : 'move', {
            from: source,
            to: destination,
            uids,
          });
          return jsonResult({
            action: copying ? 'copied' : 'moved',
            source,
            destination,
            uids,
          });
        });
      })
  );

  server.registerTool(
    'delete_messages',
    {
      title: 'Delete messages',
      description:
        'Permanently deletes messages: sets \\Deleted and expunges them. On ' +
        'most servers this does not go to Trash — move them there instead if ' +
        'that is what is meant. Asks the user to confirm; where the client ' +
        'cannot show a prompt, it falls back to a two-call token.',
      inputSchema: {
        uids: uidListParam,
        mailbox: optionalMailboxParam,
        confirm_token: confirmTokenParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ uids, mailbox, confirm_token }) =>
      run(async () => {
        const source = mailbox ?? client.defaultMailbox;
        const approval = await requestApproval(server, confirmations, {
          what: `Permanently delete ${uids.length} message(s) from "${source}" (UIDs ${uids.slice(0, 20).join(', ')}${uids.length > 20 ? ', …' : ''})`,
          consequence:
            'The messages are expunged, not moved to Trash. They cannot be recovered from here.',
          resourceKey: setResourceKey(
            `delete_messages:${source}`,
            uids.map(String)
          ),
          token: confirm_token,
        });
        if (!approval.approved) return approval.result;

        return client.withMailbox(mailbox, false, async (connection) => {
          await withTimeout(
            connection.messageDelete(uids, { uid: true }),
            'EXPUNGE'
          );
          audit('delete', { mailbox: source, uids });
          return jsonResult({ action: 'deleted', mailbox: source, uids });
        });
      })
  );

  server.registerTool(
    'manage_mailbox',
    {
      title: 'Create, rename or delete a mailbox',
      description:
        'Creates a folder, renames one, or deletes one. Deleting asks the user ' +
        'to confirm and takes every message in the folder with it; renaming ' +
        'uses the two-call token because it is reversible.',
      inputSchema: {
        action: z
          .enum(['create', 'rename', 'delete'])
          .describe('What to do with the mailbox.'),
        mailbox: mailboxParam.describe(
          'The mailbox to create, rename or delete.'
        ),
        new_name: mailboxParam
          .optional()
          .describe('Required for "rename": the full new path.'),
        confirm_token: confirmTokenParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ action, mailbox, new_name, confirm_token }) =>
      run(async () => {
        if (action === 'rename' && new_name === undefined) {
          throw new ToolInputError(
            'imap-mcp: "rename" needs new_name — the full new mailbox path.'
          );
        }

        if (action === 'delete') {
          const approval = await requestApproval(server, confirmations, {
            what: `Delete the mailbox "${mailbox}"`,
            consequence:
              'Every message in the folder is deleted with it, and it cannot be recovered from here.',
            resourceKey: `manage_mailbox:delete:${mailbox}`,
            token: confirm_token,
          });
          if (!approval.approved) return approval.result;
        } else if (action === 'rename') {
          const key = `manage_mailbox:rename:${mailbox}:${new_name ?? ''}`;
          if (!confirmations.consume(key, confirm_token)) {
            return textResult(
              confirmationPrompt(
                `rename the mailbox "${mailbox}" to "${new_name}"`,
                confirmations.issue(key),
                confirmations.ttlMinutes,
                'Clients that cached the old path will have to resynchronise.'
              )
            );
          }
        }

        return client.withConnection(async (connection) => {
          if (action === 'create') {
            await withTimeout(connection.mailboxCreate(mailbox), 'CREATE');
          } else if (action === 'rename') {
            await withTimeout(
              connection.mailboxRename(mailbox, new_name as string),
              'RENAME'
            );
          } else {
            await withTimeout(connection.mailboxDelete(mailbox), 'DELETE');
          }
          audit(`mailbox_${action}`, { mailbox, new_name });
          return jsonResult({
            action,
            mailbox,
            ...(new_name === undefined ? {} : { new_name }),
          });
        });
      })
  );

  server.registerTool(
    'save_draft',
    {
      title: 'Save a draft',
      description:
        'Composes a plain-text message and stores it in the Drafts folder. ' +
        'This server cannot send mail — the draft waits in the mailbox until a ' +
        'person opens it in their own mail client and sends it from there. ' +
        'That is deliberate: it keeps the composing useful while leaving the ' +
        'decision to send with a human.',
      inputSchema: {
        to: addressListParam,
        cc: addressListParam.optional(),
        bcc: addressListParam.optional(),
        subject: z
          .string()
          .max(500)
          .refine((v) => !/[\r\n]/.test(v), 'must not contain line breaks')
          .describe('Subject line.'),
        body: z
          .string()
          .min(1)
          .max(100_000)
          .describe('Plain-text body of the message.'),
        reply_to_uid: uidParam
          .optional()
          .describe(
            'UID of the message being answered; threads the draft through In-Reply-To and References.'
          ),
        mailbox: optionalMailboxParam.describe(
          'Where to look for reply_to_uid. Defaults to the configured mailbox.'
        ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ to, cc, bcc, subject, body, reply_to_uid, mailbox }) =>
      run(async () => {
        const thread =
          reply_to_uid === undefined
            ? undefined
            : await client.threadHeaders(mailbox, reply_to_uid);

        const draft = buildDraft({
          from: client.user,
          to,
          ...(cc === undefined ? {} : { cc }),
          ...(bcc === undefined ? {} : { bcc }),
          subject,
          body,
          ...(thread === undefined ? {} : { thread }),
        });

        const folder = await resolveDraftsMailbox(client, config);
        await client.withConnection(async (connection) => {
          await withTimeout(
            connection.append(folder, draft, ['\\Draft', '\\Seen']),
            'APPEND'
          );
        });
        audit('save_draft', {
          mailbox: folder,
          recipients: to.length + (cc?.length ?? 0) + (bcc?.length ?? 0),
          in_reply_to: thread?.messageId,
        });
        return jsonResult({
          action: 'draft_saved',
          mailbox: folder,
          recipients: [...to, ...(cc ?? []), ...(bcc ?? [])],
          note: 'The draft is stored but not sent. This server has no way to send mail; open it in your mail client to send it.',
        });
      })
  );
}

/**
 * Finds the Drafts folder.
 *
 * The `\Drafts` special-use flag is the right answer where the server reports
 * it, because folder names are localised — "Entwürfe", "Brouillons" — and
 * guessing wrong creates a stray folder rather than failing loudly.
 */
async function resolveDraftsMailbox(
  client: ImapClient,
  config: Config
): Promise<string> {
  if (config.imap.draftsMailbox !== undefined) {
    return config.imap.draftsMailbox;
  }
  const mailboxes = await client.listMailboxes();
  const found = mailboxes.find((box) => box.specialUse === '\\Drafts');
  if (found === undefined) {
    throw new ToolInputError(
      'imap-mcp: this account does not advertise a \\Drafts folder. Call ' +
        'list_mailboxes to find the right one and set IMAP_DRAFTS_MAILBOX to it.'
    );
  }
  return found.path;
}
