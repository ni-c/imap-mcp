import { Worker } from 'node:worker_threads';

import type { ExtractKind, ExtractRequest, ExtractResponse } from './types.js';

export type {
  ExtractKind,
  ExtractReason,
  ExtractRequest,
  ExtractResponse,
} from './types.js';

/**
 * How long a document may be parsed before the thread doing it is stopped.
 *
 * Below the IMAP command timeout, so an extraction never outlives the fetch
 * that fed it. Generous next to the five seconds a regular expression gets in
 * the sibling servers, because a hundred-page PDF is honest work — and finite,
 * because a document that has not finished by now is not going to.
 */
export const EXTRACT_TIMEOUT_MS = 20_000;

/**
 * Characters the worker may return, before any of the paging below.
 *
 * Not a context budget — that is `max_chars` at the tool, and it is much
 * smaller. This is the ceiling on what is held in memory and paged through.
 */
export const MAX_EXTRACT_CHARS = 1_000_000;

/**
 * Memory the parsing thread may use.
 *
 * Exceeding it kills the thread with `ERR_WORKER_OUT_OF_MEMORY`, which arrives
 * as an event this module can answer. Without it, the same runaway parse is a
 * cgroup OOM kill of the whole process — and in the deployment this feature was
 * written for, that process is the server.
 *
 * It bounds V8's heap, so it bounds a pathological object graph. It does not
 * reliably bound one enormous typed array, which is external memory; the entry
 * caps in `ooxml.ts` are what cover that.
 */
const WORKER_MEMORY_MB = 256;
const WORKER_YOUNG_MEMORY_MB = 32;

/** Content types this server can read text out of, and what each one is. */
const EXTRACTABLE = new Map<string, ExtractKind>([
  ['application/pdf', 'pdf'],
  [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'docx',
  ],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  [
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'pptx',
  ],
  ['application/vnd.oasis.opendocument.text', 'odt'],
  ['application/vnd.oasis.opendocument.spreadsheet', 'ods'],
]);

/** The same set as content types, for `get_server_info`. */
export const EXTRACTABLE_TYPES: string[] = [...EXTRACTABLE.keys()];

/** Prose for the refusals, so every one of them names the same set. */
export const EXTRACTABLE_TYPE_NAMES =
  'PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx) and OpenDocument text ' +
  'and spreadsheets (.odt, .ods)';

export function extractKindOf(contentType: string): ExtractKind | undefined {
  return EXTRACTABLE.get(contentType.toLowerCase());
}

export function isExtractable(contentType: string): boolean {
  return EXTRACTABLE.has(contentType.toLowerCase());
}

/** The magic-byte verdict an honest container of this kind produces. */
export function expectedSignature(kind: ExtractKind): string {
  // Every OOXML and OpenDocument file is a zip, which is why `sniffContent`
  // reports one for all five of them.
  return kind === 'pdf' ? 'application/pdf' : 'application/zip';
}

/**
 * Serialises extractions.
 *
 * One worker per call and no limit would mean N concurrent tool calls holding N
 * isolates of {@link WORKER_MEMORY_MB} each, which is a memory limit that
 * multiplies by a number the caller chooses. The queue is the whole mechanism:
 * the next extraction starts when the previous thread is gone.
 */
let queue: Promise<unknown> = Promise.resolve();

export async function extractDocumentText(
  request: ExtractRequest,
  limits: WorkerLimits = {}
): Promise<ExtractResponse> {
  const run = queue.then(
    () => runInWorker(request, limits),
    () => runInWorker(request, limits)
  );
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Narrowed by the tests, never by the server.
 *
 * The timeout and the memory ceiling are the two guards whose whole purpose is
 * what happens when they fire, and neither can be reached in a test at its real
 * value without a document engineered to spend twenty seconds or a quarter of a
 * gigabyte. Making them arguments is what lets the failure paths be exercised
 * in milliseconds; nothing in `src/` passes them.
 */
export interface WorkerLimits {
  timeoutMs?: number;
  memoryMb?: number;
}

async function runInWorker(
  request: ExtractRequest,
  limits: WorkerLimits = {}
): Promise<ExtractResponse> {
  const timeoutMs = limits.timeoutMs ?? EXTRACT_TIMEOUT_MS;
  // A copy this function owns. `readCapped` builds its buffer with
  // `Buffer.concat`, which is pool-backed below 4 kB — transferring that
  // ArrayBuffer would detach the shared allocator pool and quietly corrupt
  // every unrelated Buffer sitting in it.
  const bytes = new Uint8Array(request.bytes);

  const worker = new Worker(
    new URL(
      import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js',
      import.meta.url
    ),
    {
      workerData: { ...request, bytes } satisfies ExtractRequest,
      transferList: [bytes.buffer],
      resourceLimits: {
        maxOldGenerationSizeMb: limits.memoryMb ?? WORKER_MEMORY_MB,
        maxYoungGenerationSizeMb: WORKER_YOUNG_MEMORY_MB,
      },
      // Not tidiness — correctness. A worker's stdout is piped into the
      // parent's by default, the parent's stdout is this server's JSON-RPC
      // transport, and pdf.js logs. One line from inside the parser would
      // corrupt the framing and hang the session. Held open and dropped;
      // stderr is forwarded, because that is where every other diagnostic in
      // this server already goes.
      stdout: true,
      stderr: true,
    }
  );
  worker.stdout.resume();
  worker.stderr.pipe(process.stderr);

  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<ExtractResponse>((resolve) => {
      timer = setTimeout(() => {
        resolve({ ok: false, reason: 'timeout' });
      }, timeoutMs);
      worker.once('message', (value: ExtractResponse) => {
        resolve(value);
      });
      worker.once('error', (error: NodeJS.ErrnoException) => {
        resolve({
          ok: false,
          reason:
            error.code === 'ERR_WORKER_OUT_OF_MEMORY'
              ? 'out-of-memory'
              : 'internal',
        });
      });
      worker.once('exit', () => {
        // Only reached when the worker left without answering; a normal run has
        // already resolved above and this is ignored.
        resolve({ ok: false, reason: 'internal' });
      });
    });
  } finally {
    if (timer) clearTimeout(timer);
    // Unconditional: on the timeout path the thread is still inside the parse
    // and will never exit on its own, and a leaked worker holds its heap and
    // its copy of the document for the lifetime of the process.
    await worker.terminate();
  }
}
