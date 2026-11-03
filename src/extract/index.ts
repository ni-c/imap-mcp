import { fork } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { escapeInvisible } from '../analyze.js';
import type {
  ExtractHeartbeat,
  ExtractKind,
  ExtractRequest,
  ExtractResponse,
} from './types.js';

export type {
  ExtractKind,
  ExtractReason,
  ExtractRequest,
  ExtractResponse,
} from './types.js';

/**
 * How long a document may be parsed before the process doing it is killed.
 *
 * Generous next to the five seconds a regular expression gets in the sibling
 * servers, because a hundred-page PDF is honest work — and finite, because a
 * document that has not finished by now is not going to.
 */
export const EXTRACT_TIMEOUT_MS = 20_000;

/**
 * Characters the child may return, before any of the paging below.
 *
 * Not a context budget — that is `max_chars` at the tool, and it is much
 * smaller. This is the ceiling on what is held in memory and paged through,
 * and the child enforces it for every format: nothing larger is ever built
 * there, let alone sent back.
 */
export const MAX_EXTRACT_CHARS = 1_000_000;

/**
 * V8 heap the parsing process may use.
 *
 * Best effort, and named as such. It bounds a pathological object graph, and
 * when it fires the child aborts — on its own, which is the whole reason the
 * parse is in a process. It does not bound typed arrays, which are external
 * memory; the deflate pre-scan in `pdf.ts` and the entry caps in `ooxml.ts`
 * are what cover those.
 */
const CHILD_MEMORY_MB = 256;

/**
 * Resident memory the parsing process may reach before it is killed from
 * outside.
 *
 * The backstop for everything {@link CHILD_MEMORY_MB} cannot see. pdf.js
 * inflates synchronously into typed arrays outside the V8 heap, and a
 * synchronous inflate cannot be interrupted from inside the process that is
 * running it — no timer fires, no message is read — so only the parent can stop
 * it. The pre-scan in `pdf.ts` is the first line; this is what remains when the
 * pre-scan and pdf.js disagree about what a stream is. Well above an honest
 * document: a large PDF at the per-stream limit sits well under half of it.
 */
const MAX_CHILD_RSS_MB = 768;

/** How often the child's resident size is read. */
const RSS_POLL_MS = 50;

/**
 * Characters of one line of the child's stderr that are forwarded, and lines
 * forwarded per child. What the child prints is partly written by the document:
 * pdf.js warnings quote it.
 */
const MAX_STDERR_LINE = 300;
const MAX_STDERR_LINES = 50;

/**
 * Requests admitted at once, running and waiting together.
 *
 * Extractions run one at a time (see {@link queue}), so a request that arrives
 * behind seven others would wait up to seven timeouts for its turn, holding
 * its mailbox lock throughout. Past this many it is refused outright, which is
 * an answer the caller can act on.
 */
const MAX_IN_FLIGHT = 8;

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
 * One process per call and no limit would mean N concurrent tool calls holding
 * N processes of {@link CHILD_MEMORY_MB} each, which is a memory limit that
 * multiplies by a number the caller chooses. The queue is the whole mechanism:
 * the next extraction starts when the previous process is gone.
 */
let queue: Promise<unknown> = Promise.resolve();
let inFlight = 0;

export async function extractDocumentText(
  request: ExtractRequest,
  limits: ChildLimits = {}
): Promise<ExtractResponse> {
  if (inFlight >= MAX_IN_FLIGHT) return { ok: false, reason: 'busy' };
  inFlight += 1;
  try {
    const run = queue.then(
      () => runInChild(request, limits),
      () => runInChild(request, limits)
    );
    queue = run.catch(() => undefined);
    return await run;
  } finally {
    inFlight -= 1;
  }
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
export interface ChildLimits {
  timeoutMs?: number;
  memoryMb?: number;
  rssMb?: number;
  /** Makes the child try a forbidden read instead of parsing; see `child.ts`. */
  probe?: 'parent-environ' | 'stderr-escape';
  /** Ignore `/proc` and go by the child's own heartbeat, as on other systems. */
  heartbeatOnly?: boolean;
}

/** A code for the log, never a message. */
function codeOf(error: unknown): string {
  const value = error as { code?: unknown; name?: unknown } | null;
  if (typeof value?.code === 'string') return value.code;
  if (typeof value?.name === 'string') return value.name;
  return 'unknown';
}

/**
 * Paths the child may read, and nothing else.
 *
 * The child runs under Node's permission model. A parser exploit then has code
 * execution in a process that can read exactly its own modules and the two
 * packages that parse documents — not `/proc/<ppid>/environ`, where the
 * server's IMAP password is for as long as it runs, and not the home
 * directory. It also cannot spawn a process, start a worker or load an addon,
 * which the model denies by default.
 *
 * Files, not directories, for this package's own modules: the child needs four
 * of them, and `analyze` is the only one outside `extract/`. The packages are
 * read whole because pdf.js loads its codecs on demand.
 */
let allowed: string[] | undefined;

function readableByChild(): string[] {
  if (allowed !== undefined) return allowed;
  const here = fileURLToPath(import.meta.url);
  const extension = here.endsWith('.ts') ? 'ts' : 'js';
  const directory = dirname(here);
  const own = [
    join(directory, `child.${extension}`),
    join(directory, `pdf.${extension}`),
    join(directory, `ooxml.${extension}`),
    join(directory, '..', `analyze.${extension}`),
  ];
  const require = createRequire(import.meta.url);
  const packages = ['unpdf', 'fflate'].map((name) =>
    packageRoot(require.resolve(name), name)
  );
  allowed = [...own, ...packages].map((path) => realpathSync(path));
  return allowed;
}

/** The directory holding the `package.json` of `name`, above `entry`. */
function packageRoot(entry: string, name: string): string {
  for (let directory = dirname(entry); ; directory = dirname(directory)) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest)) {
      const found = (
        JSON.parse(readFileSync(manifest, 'utf8')) as {
          name?: unknown;
        }
      ).name;
      if (found === name) return directory;
    }
    if (dirname(directory) === directory) {
      throw new Error(`package root of ${name} not found`);
    }
  }
}

/**
 * Forwards the child's stderr one escaped, length-capped line at a time.
 *
 * Raw inheritance let a document write to the terminal: pdf.js's warnings
 * quote object names and operators, and an escape sequence in one of them
 * reached whoever reads this server's log.
 */
function forwardStderr(stream: Readable): void {
  let pending = '';
  let truncated = false;
  let lines = 0;
  const emit = (): void => {
    if (lines < MAX_STDERR_LINES && (pending !== '' || truncated)) {
      lines += 1;
      console.error(
        `imap-mcp: extraction child: ${escapeInvisible(pending)}${truncated ? '…' : ''}`
      );
    }
    pending = '';
    truncated = false;
  };
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    const pieces = chunk.split(/\r\n|\n|\r/);
    pieces.forEach((piece, index) => {
      if (index > 0) emit();
      const room = MAX_STDERR_LINE - pending.length;
      if (piece.length > room) truncated = true;
      pending += piece.slice(0, Math.max(room, 0));
    });
  });
  stream.on('end', emit);
}

/** Resident set size of a process in bytes, where the system says. */
async function residentBytes(pid: number): Promise<number | undefined> {
  if (process.platform !== 'linux') return undefined;
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    const kilobytes = /^VmRSS:\s+(\d+)\s+kB/m.exec(status)?.[1];
    return kilobytes === undefined ? undefined : Number(kilobytes) * 1024;
  } catch {
    return undefined;
  }
}

function isHeartbeat(value: unknown): value is ExtractHeartbeat {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { heartbeat?: unknown }).heartbeat === true
  );
}

async function runInChild(
  request: ExtractRequest,
  limits: ChildLimits = {}
): Promise<ExtractResponse> {
  const timeoutMs = limits.timeoutMs ?? EXTRACT_TIMEOUT_MS;
  const memoryMb = limits.memoryMb ?? CHILD_MEMORY_MB;
  const rssLimit = (limits.rssMb ?? MAX_CHILD_RSS_MB) * 1024 * 1024;

  const child = fork(
    new URL(
      import.meta.url.endsWith('.ts') ? './child.ts' : './child.js',
      import.meta.url
    ),
    [],
    {
      // Stated rather than inherited. The parent's own flags may be ones a
      // child cannot take — `--input-type` is one — and an inherited flag that
      // fails to parse would turn every extraction into a silent `internal`.
      execArgv: [
        `--max-old-space-size=${memoryMb}`,
        '--permission',
        ...readableByChild().map((path) => `--allow-fs-read=${path}`),
      ],
      // Nothing from the server's environment: it holds the mailbox password,
      // and the child has no use for any of it.
      env:
        limits.probe === undefined
          ? {}
          : { IMAP_MCP_EXTRACT_PROBE: limits.probe },
      // Not tidiness — correctness. The parent's stdout is this server's
      // JSON-RPC transport, and pdf.js logs. One line from inside the parser
      // would corrupt the framing and hang the session. Discarded. Stderr is
      // piped and forwarded line by line, escaped: it is where every other
      // diagnostic in this server goes, and some of what pdf.js prints there
      // is the document's own text.
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      // Structured clone rather than JSON: the request carries the document as
      // a typed array, and JSON would turn it into an array of numbers ten
      // times its size.
      serialization: 'advanced',
    }
  );
  forwardStderr(child.stderr as Readable);

  let timer: NodeJS.Timeout | undefined;
  let poll: NodeJS.Timeout | undefined;
  try {
    return await new Promise<ExtractResponse>((resolve) => {
      // The first answer wins. Everything after it — the exit of a child that
      // was killed because it had already answered, most of all — is silence,
      // not a second verdict.
      let settled = false;
      const settle = (value: ExtractResponse): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      timer = setTimeout(() => {
        settle({ ok: false, reason: 'timeout' });
      }, timeoutMs);
      const overCeiling = (rss: number): void => {
        if (rss <= rssLimit || settled) return;
        console.error('imap-mcp: extraction stopped: memory ceiling reached');
        settle({ ok: false, reason: 'too-large' });
      };
      child.on('message', (value) => {
        if (isHeartbeat(value)) overCeiling(value.rss);
        else settle(value as ExtractResponse);
      });
      if (child.pid !== undefined && limits.heartbeatOnly !== true) {
        const pid = child.pid;
        poll = setInterval(() => {
          void residentBytes(pid).then((rss) => {
            if (rss !== undefined) overCeiling(rss);
          });
        }, RSS_POLL_MS);
      }
      child.once('error', (error) => {
        if (settled) return;
        console.error(`imap-mcp: extraction process failed: ${codeOf(error)}`);
        settle({ ok: false, reason: 'internal' });
      });
      child.once('exit', (code, signal) => {
        // Only reached when the child left without answering. An abort is what
        // V8 does when the heap limit is hit — and what the process does
        // *instead of* taking the server with it, which is the property being
        // bought here.
        if (settled) return;
        if (signal === 'SIGABRT' || code === 134) {
          settle({ ok: false, reason: 'out-of-memory' });
          return;
        }
        console.error(
          `imap-mcp: extraction process exited early: ${signal ?? `code ${code}`}`
        );
        settle({ ok: false, reason: 'internal' });
      });
      try {
        child.send(request);
      } catch (error) {
        console.error(`imap-mcp: extraction request failed: ${codeOf(error)}`);
        settle({ ok: false, reason: 'internal' });
      }
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (poll) clearInterval(poll);
    // Unconditional: on the timeout path the process is still inside the parse
    // and will never exit on its own. SIGKILL, because a parser stuck in native
    // code does not check for anything gentler — and because a process, unlike
    // a thread, can be killed from outside whatever it is doing.
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }
}
