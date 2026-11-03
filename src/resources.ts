import { ResourceTemplate } from '@modelcontextprotocol/server';
import type {
  McpServer,
  ReadResourceResult,
  ServerContext,
} from '@modelcontextprotocol/server';
import {
  checkPolicy,
  collectAttachments,
  describeExecutable,
  imageTypeOf,
  sniffContent,
} from './attachments.js';

import { escapeInvisible } from './analyze.js';
import type { Config } from './config.js';
import { ToolInputError } from './errors.js';
import { collectFetch, ImapClient } from './imap.js';
import { errorMessageOf } from './result.js';
import { mailboxParam } from './schema.js';
import { downloadCapped } from './stream.js';

const MAX_UID = 4_294_967_295;

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
  const metadata = {
    title: 'Message attachment',
    description:
      'Raw bytes of one attachment. The same allowlist, size limit and ' +
      'magic-byte check apply as for get_attachments. Add ?mailbox=<name> for ' +
      'a message outside the default mailbox.',
  };
  const read = async (
    uri: URL,
    variables: Record<string, string | string[]>,
    ctx: ServerContext
  ): Promise<ReadResourceResult> => {
    try {
      return await readAttachment(
        uri,
        variables,
        client,
        config,
        ctx.mcpReq.signal
      );
    } catch (error) {
      // A resource read has no isError result to return, so the error is
      // thrown — but it takes the same road as a tool error: the library's
      // own message, which quotes what it saw, is bounded and has its
      // invisible characters spelled out.
      throw new Error(errorMessageOf(error), { cause: error });
    }
  };

  // The template with the query comes first: the plain one would match the
  // same URI and swallow `?mailbox=…` into the part id.
  for (const [name, template] of [
    ['attachment-in-mailbox', 'imap://message/{uid}/part/{partId}{?mailbox}'],
    ['attachment', 'imap://message/{uid}/part/{partId}'],
  ] as const) {
    server.registerResource(
      name,
      // Enumerating every attachment of every message would mean walking the
      // whole mailbox; the listing tools are how these are discovered.
      new ResourceTemplate(template, { list: undefined }),
      metadata,
      read
    );
  }
}

async function readAttachment(
  uri: URL,
  variables: Record<string, string | string[]>,
  client: ImapClient,
  config: Config,
  signal: AbortSignal | undefined
): Promise<ReadResourceResult> {
  const uidText = first(variables.uid);
  const partId = first(variables.partId);
  // The URI is the caller's and unbounded; a refusal quotes a bounded,
  // cleaned copy of it rather than however much was sent.
  const shown = escapeInvisible(uri.href.slice(0, 200));
  // Strict, because `Number()` also accepts 0x10, 1e1 and ' 7 '.
  const uid = /^[1-9][0-9]{0,9}$/.test(uidText) ? Number(uidText) : 0;
  if (uid < 1 || uid > MAX_UID) {
    throw new ToolInputError(`imap-mcp: ${shown} has no valid UID.`);
  }
  if (!/^[0-9]+(\.[0-9]+)*$/.test(partId)) {
    throw new ToolInputError(`imap-mcp: ${shown} has no valid MIME part id.`);
  }
  // Read from the URL rather than from the template variables, which are not
  // percent-decoded.
  const requested = uri.searchParams.get('mailbox');
  let mailbox: string | undefined;
  if (requested !== null) {
    if (!mailboxParam.safeParse(requested).success) {
      throw new ToolInputError(`imap-mcp: ${shown} has no valid mailbox.`);
    }
    mailbox = requested;
  }

  return client.withMailbox(mailbox, true, signal, async (connection) => {
    const rows = await collectFetch(
      connection.fetch(
        [uid],
        { uid: true, bodyStructure: true },
        { uid: true }
      ),
      [uid],
      client.commandTimeoutMs
    );
    const structure = rows.find(
      (row) => row.bodyStructure !== undefined
    )?.bodyStructure;
    if (structure === undefined) {
      throw new ToolInputError(
        `imap-mcp: no message with UID ${uid} in this mailbox.`
      );
    }

    const candidate = collectAttachments(structure)
      .map((entry) =>
        checkPolicy(entry, {
          allowedTypes: config.imap.allowedAttachmentTypes,
          // The inline budget, not the disk one. The bytes come back
          // base64-encoded in a JSON-RPC response — that is context, and
          // maxDownloadBytes exists to bound what may be written to a file.
          // Using it here allowed ~34 MB of base64 in one response, where
          // get_attachments caps the same attachment at 1 MB. The same
          // reasoning excludes IMAP_MAX_EXTRACT_BYTES: there is no text
          // mode on this door, so nothing here can be reached by it.
          maxBytes: config.imap.maxAttachmentBytes,
          maxBytesName: 'IMAP_MAX_ATTACHMENT_BYTES',
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

    const { buffer } = await downloadCapped(
      connection,
      uid,
      partId,
      config.imap.maxAttachmentBytes,
      client.commandTimeoutMs
    );
    if (buffer === undefined) {
      throw new ToolInputError(
        `imap-mcp: the attachment exceeds IMAP_MAX_ATTACHMENT_BYTES (${config.imap.maxAttachmentBytes}). Save it with get_attachments in "file" mode instead.`
      );
    }
    const verdict = sniffContent(buffer);
    if (verdict.executable) {
      throw new ToolInputError(
        `imap-mcp: refused: the bytes are ${describeExecutable(verdict)}, whatever the message declared.`
      );
    }

    // An image type is the bytes' own, never the sender's. Declared as an
    // image but not one: no image type at all.
    const mimeType = candidate.contentType.startsWith('image/')
      ? (imageTypeOf(verdict, config.imap.allowedAttachmentTypes) ??
        'application/octet-stream')
      : candidate.contentType;

    return {
      contents: [{ uri: uri.href, mimeType, blob: buffer.toString('base64') }],
    };
  });
}

function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}
