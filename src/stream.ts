import { ToolInputError } from './errors.js';
import { withTimeout, type ImapConnection } from './imap.js';

/**
 * Buffers a stream, giving up once the cap is passed.
 *
 * imapflow's own `maxBytes` is asked for as well, but that bounds what is
 * *requested*, not what arrives — a server that ignores it would otherwise
 * stream straight into memory. Returns undefined rather than throwing so the
 * caller can explain which limit was hit.
 */
export async function readCapped(
  stream: NodeJS.ReadableStream,
  maxBytes: number
): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      // Tear the read down rather than draining politely: the point is to stop
      // the bytes arriving, not to receive all of them and discard them.
      (stream as { destroy?: () => void }).destroy?.();
      return undefined;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Downloads one MIME part and buffers it, refusing past `maxBytes`.
 *
 * Two things the bare calls got wrong:
 *
 * - imapflow's `maxBytes` ends the stream silently at exactly that many bytes,
 *   so asking for `maxBytes` could never show more than `maxBytes` and the cap
 *   in {@link readCapped} never fired: a part cut short looked like a part that
 *   fit. Asking for one byte more makes "over the limit" observable.
 * - imapflow answers `{}` when the message or part is gone (expunged between
 *   the listing and the fetch). The destructured `content` was `undefined` and
 *   the failure was a TypeError.
 *
 * Returns `buffer: undefined` when the cap was exceeded.
 */
export async function downloadCapped(
  connection: ImapConnection,
  uid: number,
  partId: string,
  maxBytes: number
): Promise<{
  buffer: Buffer | undefined;
  meta: { contentType: string; charset?: string; filename?: string };
}> {
  const response = (await withTimeout(
    connection.download(String(uid), partId, {
      uid: true,
      maxBytes: maxBytes + 1,
    }),
    'FETCH'
  )) as Partial<Awaited<ReturnType<ImapConnection['download']>>>;
  if (response.content === undefined || response.meta === undefined) {
    throw new ToolInputError(
      `imap-mcp: part ${partId} of message ${uid} is no longer on the server (it was moved or deleted after it was listed).`
    );
  }
  // The read gets a deadline of its own, scaled to the cap: imapflow's idle
  // timer is re-armed by every byte, so a server sending one now and then
  // held the mailbox lock — and every call behind it — for as long as it
  // liked. On expiry the connection is closed, which ends the stream.
  return {
    buffer: await withTimeout(
      readCapped(response.content, maxBytes),
      'FETCH',
      downloadDeadline(maxBytes)
    ),
    meta: response.meta,
  };
}

/** 30 seconds plus 10 per MiB the cap allows. */
export function downloadDeadline(maxBytes: number): number {
  return 30_000 + Math.ceil(maxBytes / (1024 * 1024)) * 10_000;
}
