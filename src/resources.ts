import {
  ResourceTemplate,
  type McpServer,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';

import {
  checkPolicy,
  collectAttachments,
  sniffContent,
} from './attachments.js';
import type { Config } from './config.js';
import { ToolInputError } from './errors.js';
import { ImapClient, withTimeout } from './imap.js';
import { readCapped } from './stream.js';

/**
 * Exposes attachments as MCP resources.
 *
 * This is the second half of "downloadable": where `IMAP_DOWNLOAD_DIR` is unset
 * — a container, a remote deployment, anywhere the server has no useful
 * filesystem — the client can still fetch the bytes itself over the protocol
 * instead of having them base64-encoded into the conversation.
 *
 * The read callback re-runs the *entire* attachment policy. It has to: a
 * resource read does not go through `get_attachments`, so anything enforced
 * only there would simply be a second, unguarded door to the same bytes.
 */
export function registerAttachmentResources(
  server: McpServer,
  client: ImapClient,
  config: Config
): void {
  server.registerResource(
    'attachment',
    new ResourceTemplate('imap://message/{uid}/part/{partId}', {
      // Enumerating every attachment of every message would mean walking the
      // whole mailbox; the listing tools are how these are discovered.
      list: undefined,
    }),
    {
      title: 'Message attachment',
      description:
        'Raw bytes of one attachment. The same allowlist, size limit and ' +
        'magic-byte check apply as for get_attachments.',
    },
    async (uri, variables): Promise<ReadResourceResult> => {
      const uid = Number(first(variables.uid));
      const partId = first(variables.partId);
      if (!Number.isInteger(uid) || uid < 1) {
        throw new ToolInputError(`imap-mcp: ${uri.href} has no valid UID.`);
      }
      if (!/^[0-9]+(\.[0-9]+)*$/.test(partId)) {
        throw new ToolInputError(
          `imap-mcp: ${uri.href} has no valid MIME part id.`
        );
      }

      return client.withMailbox(undefined, true, async (connection) => {
        let structure;
        for await (const message of connection.fetch(
          [uid],
          { uid: true, bodyStructure: true },
          { uid: true }
        )) {
          structure = message.bodyStructure;
        }
        if (structure === undefined) {
          throw new ToolInputError(
            `imap-mcp: no message with UID ${uid} in this mailbox.`
          );
        }

        const candidate = collectAttachments(structure)
          .map((entry) =>
            checkPolicy(entry, {
              allowedTypes: config.imap.allowedAttachmentTypes,
              maxBytes: config.imap.maxDownloadBytes,
            })
          )
          .find((entry) => entry.partId === partId);
        if (candidate === undefined) {
          throw new ToolInputError(
            `imap-mcp: message ${uid} has no attachment with part id ${partId}.`
          );
        }
        if (!candidate.allowed) {
          throw new ToolInputError(
            `imap-mcp: refused: ${candidate.notes.join('; ')}`
          );
        }

        const { content } = await withTimeout(
          connection.download(String(uid), partId, {
            uid: true,
            maxBytes: config.imap.maxDownloadBytes,
          }),
          'FETCH'
        );
        const buffer = await readCapped(content, config.imap.maxDownloadBytes);
        if (buffer === undefined) {
          throw new ToolInputError(
            `imap-mcp: the attachment exceeds IMAP_MAX_DOWNLOAD_BYTES (${config.imap.maxDownloadBytes}).`
          );
        }
        if (sniffContent(buffer).executable) {
          throw new ToolInputError(
            'imap-mcp: refused: the bytes are an executable, whatever the message declared.'
          );
        }

        return {
          contents: [
            {
              uri: uri.href,
              mimeType: candidate.contentType,
              blob: buffer.toString('base64'),
            },
          ],
        };
      });
    }
  );
}

function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}
