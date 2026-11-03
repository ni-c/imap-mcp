import { constants, createInflate, inflateSync } from 'node:zlib';

import type { ExtractResponse } from './types.js';

/**
 * Pages read at most, however many the document claims.
 *
 * A mail attachment that needs more than this is not a document anyone is going
 * to read in a chat window, and the page loop is the one part of extraction
 * whose cost scales with something the sender chose.
 */
const MAX_PAGES = 100;

/** Below this many points, text is not there for a reader. */
const TINY_FONT_POINTS = 2;

/**
 * How far one compressed stream may expand, and how far all of them may
 * together, before the document is refused without a parser seeing it.
 *
 * This is the memory guard for PDFs, and it has to live here because nothing
 * else bounds it. PDF.js inflates a stream into memory in full, and that memory
 * is a typed array — external to the V8 heap, so no heap limit applies to it.
 * Measured: a 3.4 MB file whose one content stream inflates to 1 GB took the
 * process to 2.1 GB of resident memory within a second, and the extraction
 * timeout only decides when that stops growing, not how far it gets. Deflate
 * reaches roughly 1000:1 on repetitive input, so the 10 MB the size limit
 * admits by default could stand for 10 GB.
 *
 * Every honest document is far below both numbers: a content stream is tens of
 * kilobytes to a few megabytes, an embedded font a few hundred kilobytes.
 */
export const MAX_STREAM_BYTES = 32 * 1024 * 1024;
export const MAX_TOTAL_STREAM_BYTES = 128 * 1024 * 1024;

/**
 * pdf.js options, every one of them load-bearing.
 *
 * `isEvalSupported` reads like a performance knob and is not one: it gates
 * pdf.js's construction of `Function` objects for font and PostScript-calculator
 * programs taken from the document. That is the primitive that turned a parser
 * bug into remote code execution in CVE-2024-4367. Text extraction never needs
 * it.
 *
 * `useSystemFonts` overrides unpdf's own default of `true`. Nothing about
 * reading text needs the host's font configuration consulted on behalf of a
 * stranger's file.
 *
 * `verbosity` silences pdf.js's own logging. This matters more here than it
 * looks: the server's transport is stdio JSON-RPC, and a stray `console.log`
 * reaching the parent's stdout corrupts the framing and hangs the session. The
 * child process is also started with its stdout discarded, because one guard
 * is not a guard.
 */
const PDFJS_OPTIONS = {
  isEvalSupported: false,
  enableXfa: false,
  useSystemFonts: false,
  disableFontFace: true,
  verbosity: 0,
} as const;

/**
 * Reads the text layer of a PDF.
 *
 * The API surface used here is deliberately five calls wide — `getDocument`,
 * `getPage`, `getTextContent`, `view`, `destroy` — and it must stay that way.
 * `getJSActions` surfaces the document's own JavaScript, `getAttachments`
 * returns embedded files (a PDF can carry an executable past `sniffContent`,
 * which only ever looks at the outer `%PDF`), and `getAnnotations` carries
 * actions and URIs. None of them is needed to read text, and each is a door.
 *
 * Nothing here reaches the network, and that is worth stating because it is one
 * careless line away from being false. unpdf only sets `standardFontDataUrl`
 * and `cMapUrl` when it can resolve `pdfjs-dist`, which is not a dependency of
 * this package, so both stay unset; the document is passed as bytes, never as a
 * URL, so pdf.js never constructs its network stream. **Do not "fix" a missing
 * font or CMap by pointing either option at a CDN.** It is the most-suggested
 * workaround on the internet, and it would hand this server its first outbound
 * HTTP client — the one property SECURITY.md is built on. The cost of leaving
 * them unset is known and accepted: a PDF whose text needs a predefined CJK
 * CMap does not extract.
 */
export async function extractPdf(
  bytes: Uint8Array,
  maxChars: number
): Promise<ExtractResponse> {
  // Before the parser, not inside it: by the time pdf.js has inflated a stream
  // the memory is spent, and there is no option that makes it stop earlier.
  if (await expandsTooFar(bytes)) return { ok: false, reason: 'too-large' };

  const { getDocumentProxy } = await import('unpdf');

  let pdf;
  try {
    // Normalised, not passed through. A Node `Buffer` is a `Uint8Array`, so it
    // satisfies the signature — but it is a view into a shared allocation pool
    // at a non-zero `byteOffset`, and pdf.js reaches for the underlying
    // `ArrayBuffer`. Handed a Buffer it reads the pool instead of the document
    // and reports a corrupt file, which is a bug that looks exactly like a bad
    // attachment. `set` on a fresh array is the copy that ends it.
    const owned = new Uint8Array(bytes.byteLength);
    owned.set(bytes);
    pdf = await getDocumentProxy(owned, PDFJS_OPTIONS);
  } catch (error) {
    return { ok: false, reason: reasonFor(error) };
  }

  try {
    const declared = pdf.numPages;
    const pageCount = Math.min(declared, MAX_PAGES);
    const parts: string[] = [];
    let length = 0;
    // Set only by the character cap. It used to be initialised from
    // `declared > pageCount`, and since the loop below ran only while it was
    // false, a document with more than a hundred pages was never read at all
    // and came back as "no text layer" — the diagnosis for a scan, on a long
    // contract. The page count the walk stopped short of is reported
    // separately, as `declaredUnitCount`.
    let clipped = false;
    let hiddenRuns = 0;
    let totalRuns = 0;

    // Sequentially, not `Promise.all` over the page count — which is what
    // unpdf's own `extractText` does. That form allocates an array as long as
    // the document claims to be and holds every page's text content live at
    // once, both sized by a number the sender wrote.
    for (let page = 1; page <= pageCount; page += 1) {
      const proxy = await pdf.getPage(page);
      const box = proxy.view;
      const content = await proxy.getTextContent();
      const line: string[] = [];
      for (const item of content.items) {
        if (!('str' in item)) continue;
        totalRuns += 1;
        if (isHidden(item, box)) hiddenRuns += 1;
        line.push(item.str);
        if (item.hasEOL) line.push('\n');
      }
      const text = line.join('');
      if (length + text.length >= maxChars) {
        parts.push(text.slice(0, maxChars - length));
        clipped = true;
        break;
      }
      parts.push(text, '\n');
      length += text.length + 1;
    }

    const text = parts.join('');
    // Trimmed, because an image-only PDF still yields the page separators this
    // loop writes. `text !== ''` would call a scanned invoice a text document.
    if (text.trim() === '') return { ok: false, reason: 'no-text-layer' };

    return {
      ok: true,
      text,
      unitLabel: 'pages',
      unitCount: pageCount,
      ...(declared > pageCount ? { declaredUnitCount: declared } : {}),
      clipped,
      hiddenRuns,
      totalRuns,
    };
  } catch (error) {
    return { ok: false, reason: reasonFor(error) };
  } finally {
    // Releases the parsing state. The process is about to exit anyway, but a
    // document that fails on page 3 of 100 should not hold its object graph
    // while the remaining pages are abandoned. `destroy` is on the loading
    // task, not on the document proxy — the proxy only has `cleanup`, which
    // keeps the transport alive.
    await pdf.loadingTask.destroy().catch(() => undefined);
  }
}

/**
 * Whether a text run is drawn where a reader will not find it.
 *
 * A signal, never a filter — the same position this server takes on suspicious
 * mail. Two of the four ways to hide text in a PDF are visible from here (off
 * the page, and set microscopically small) and two are not: fill colour is not
 * exposed by the text-content API at all, and text render mode 3 is exactly how
 * every OCR'd scan stores the text layer over its own image, so treating it as
 * hidden would reject the main thing this feature exists to read.
 *
 * So the count goes into a note, the text goes to the model either way, and the
 * result header says plainly that some of what follows is text a person opening
 * the document would not see.
 *
 * "Off the page" is measured against the page's own box, not against the
 * origin: a MediaBox need not start at 0,0, and text past the right or top
 * edge is as invisible as text past the left one.
 */
function isHidden(
  item: { transform?: unknown; height?: number },
  box: number[]
): boolean {
  const t = item.transform;
  if (Array.isArray(t) && t.length >= 6) {
    const x = Number(t[4]);
    const y = Number(t[5]);
    const [x0, y0, x1, y1] = box;
    // Measured against pdf.js 6: a run placed *entirely* off the page produces
    // no text item at all, so this catches the half that hangs over an edge
    // and the other half never arrives — which is the better outcome and not
    // one to undo.
    if (
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      (x < (x0 ?? 0) ||
        y < (y0 ?? 0) ||
        x > (x1 ?? Infinity) ||
        y > (y1 ?? Infinity))
    ) {
      return true;
    }
  }
  const size = item.height ?? 0;
  return size > 0 && size < TINY_FONT_POINTS;
}

/**
 * Maps a pdf.js rejection to a reason code.
 *
 * On the name, never the message. The message is a pdf.js implementation
 * detail that changes between releases, and it quotes the document.
 */
function reasonFor(error: unknown): 'encrypted' | 'corrupt' {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'PasswordException' ? 'encrypted' : 'corrupt';
}

/* ------------------------------------------------------------ pre-scan -- */

/**
 * How far back from a `stream` keyword the dictionary is looked for, at most.
 * Only `/Length` is read from it, and only to delimit the data; an honest
 * stream dictionary is a few hundred bytes.
 */
const DICT_WINDOW = 8192;

/**
 * Wall-clock ceiling on the pre-scan. Honest documents finish in a small
 * fraction of it; a file built to make the scan itself expensive is refused
 * rather than waited for.
 */
const SCAN_DEADLINE_MS = 8_000;

/** Decoder input the pre-scan may spend, beyond a multiple of the file size. */
const SCAN_WORK_BASE = 64 * 1024 * 1024;

/** Nested Flate layers followed before the chain is called measured. */
const MAX_FLATE_DEPTH = 4;

/**
 * Whether the document's streams expand past the limits above.
 *
 * Measured by trial, never by declaration. pdf.js reads a stream's filter with
 * `dict.get('F', 'Filter')`, resolves indirect references and decodes `#xx` in
 * names; any reader of the dictionary that is not pdf.js itself disagrees with
 * it somewhere, and the disagreement is the bypass. So the dictionary is not
 * asked. Every `stream` keyword is taken for a stream, and its raw data goes
 * through every decoder that can grow — Flate (and Flate inside Flate), LZW,
 * RunLength, each bare or behind an ASCIIHex or ASCII85 wrapper — and the
 * largest result counts. A decoder fed data that is not its format stops at
 * once or produces nothing, so an honest stream costs one useful trial and
 * a few that end at the first byte. The decoders stop the moment they cross
 * the remaining budget, which bounds the work by the budget plus one stream.
 *
 * Only the extent of the data is read from the dictionary, because RunLength
 * and LZW do not reject foreign bytes the way Flate does: `/Length`, direct or
 * a resolvable reference, counts where pdf.js would honour it — where
 * `endstream` follows, whitespace allowed — and the span is the larger of that
 * and the distance to the first `endstream` keyword. Using the keyword alone
 * would let a sender end a measurement early by writing the word inside their
 * own compressed bytes, and using `/Length` alone would let a wrong one hide a
 * stream.
 *
 * No stream is skipped because an earlier one claims to cover it: objects may
 * overlap, and pdf.js reaches them by cross-reference offset. What keeps that
 * affordable is that all searching moves forward — one cursor for streams, one
 * for `obj`, one index of object numbers built on first use — and that the
 * decoders' input is charged against a budget proportional to the file.
 *
 * Image codecs — DCT, JPX, JBIG2, CCITT — are not decoded here, because text
 * extraction never decodes them either. A stream they own is raw bytes to
 * every decoder above, which reject it at once.
 */
export async function expandsTooFar(bytes: Uint8Array): Promise<boolean> {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // latin1 keeps a one-to-one mapping between string index and byte offset.
  const text = data.toString('latin1');
  const deadline = performance.now() + SCAN_DEADLINE_MS;
  let workLeft = SCAN_WORK_BASE + 8 * data.length;
  let total = 0;
  let cursor = 0;
  let lastObject = -1;
  let nextObject = text.indexOf('obj');
  let endstream = text.indexOf('endstream');
  let objects: Map<number, number> | undefined;

  for (;;) {
    const at = text.indexOf('stream', cursor);
    if (at < 0) return false;
    cursor = at + 6;
    if (!isKeyword(text, at, 6)) continue;
    if (performance.now() > deadline) return true;

    const start = dataStart(text, at + 6);
    // A forward cursor: once no `endstream` is left there never is again, and
    // a keyword found stays the answer until a later stream starts past it.
    if (endstream >= 0 && endstream < start) {
      endstream = text.indexOf('endstream', start);
    }
    let end = endstream < 0 ? data.length : endstream;

    while (nextObject >= 0 && nextObject < at) {
      lastObject = nextObject;
      nextObject = text.indexOf('obj', nextObject + 3);
    }
    const from = Math.max(
      lastObject < 0 ? 0 : lastObject + 3,
      at - DICT_WINDOW
    );
    workLeft -= at - from + 64;
    for (const declared of lengthsIn(text, from, at, () => {
      objects ??= indexObjects(text);
      return objects;
    })) {
      const after = start + declared;
      if (after > data.length) continue;
      let probe = after;
      while (probe - after < 4096 && isSpace(text.charCodeAt(probe)))
        probe += 1;
      workLeft -= probe - after;
      if (text.startsWith('endstream', probe)) end = Math.max(end, after);
    }

    const span = data.subarray(start, end);
    workLeft -= span.length;
    if (workLeft < 0) return true;

    const limit = Math.min(MAX_STREAM_BYTES, MAX_TOTAL_STREAM_BYTES - total);
    const size = await largestExpansion(span, limit);
    if (size > limit) return true;
    total += size;
  }
}

/**
 * Whether `length` characters at `at` form a keyword: not the tail of
 * `endstream` and not the head of a longer word. PDF's regular characters are
 * everything but whitespace and delimiters, so a keyword may sit against a `>`
 * or a `]` as well as a space.
 */
function isKeyword(text: string, at: number, length: number): boolean {
  return (
    (at === 0 || !isRegular(text.charCodeAt(at - 1))) &&
    !isRegular(text.charCodeAt(at + length))
  );
}

function isSpace(code: number): boolean {
  return (
    code === 32 ||
    code === 10 ||
    code === 13 ||
    code === 9 ||
    code === 12 ||
    code === 0
  );
}

function isRegular(code: number): boolean {
  if (Number.isNaN(code) || isSpace(code)) return false;
  // ( ) < > [ ] { } / %
  return !(
    code === 40 ||
    code === 41 ||
    code === 60 ||
    code === 62 ||
    code === 91 ||
    code === 93 ||
    code === 123 ||
    code === 125 ||
    code === 47 ||
    code === 37
  );
}

/** Where the data begins: after the end of the line the keyword is on. */
function dataStart(text: string, from: number): number {
  const stop = Math.min(text.length, from + 256);
  for (let i = from; i < stop; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 10) return i + 1;
    if (code === 13) return text.charCodeAt(i + 1) === 10 ? i + 2 : i + 1;
  }
  return from;
}

/**
 * Every `/Length` value in a window of dictionary text, direct or through a
 * reference. All of them, not the last: a string or name later in the
 * dictionary can say `/Length` too, and the larger span is the safe one.
 */
function* lengthsIn(
  text: string,
  from: number,
  to: number,
  objects: () => Map<number, number>
): Generator<number> {
  // Searched in a slice of its own: `indexOf` on the whole text has no upper
  // bound, and a file without a `/Length` anywhere ahead would send every
  // stream's search to the end of it.
  const window = text.slice(from, to);
  let i = window.indexOf('/Length');
  while (i >= 0) {
    const j = i + 7;
    i = window.indexOf('/Length', j);
    if (isRegular(window.charCodeAt(j))) continue;
    const first = readInteger(window, j, window.length);
    if (first === undefined) continue;
    // `N G R`: the number is an object, and its body is the length.
    const generation = readInteger(window, first.end, window.length);
    if (generation !== undefined) {
      let r = generation.end;
      while (isSpace(window.charCodeAt(r))) r += 1;
      if (
        window.charCodeAt(r) === 0x52 &&
        !isRegular(window.charCodeAt(r + 1))
      ) {
        const value = objects().get(
          first.value * 65536 + (generation.value & 0xffff)
        );
        if (value !== undefined) yield value;
        continue;
      }
    }
    yield first.value;
  }
}

/** A non-negative integer after optional whitespace; at most 15 digits. */
function readInteger(
  text: string,
  from: number,
  to: number
): { value: number; end: number } | undefined {
  let i = from;
  while (i < to && isSpace(text.charCodeAt(i))) i += 1;
  const begin = i;
  let value = 0;
  while (i < to && i - begin < 15) {
    const digit = text.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) break;
    value = value * 10 + digit;
    i += 1;
  }
  return i === begin ? undefined : { value, end: i };
}

/**
 * `N G obj <integer>` for every object whose body is a bare integer: the
 * indirect lengths. Built forward from the `obj` keywords, never by a pattern
 * that restarts at every digit, and capped so the table is not sized by the
 * sender. The last definition of a number wins, as an incremental update does.
 */
function indexObjects(text: string): Map<number, number> {
  const out = new Map<number, number>();
  for (
    let at = text.indexOf('obj');
    at >= 0 && out.size < 500_000;
    at = text.indexOf('obj', at + 3)
  ) {
    const body = readInteger(text, at + 3, text.length);
    if (body === undefined) continue;
    // Backwards over `N G `: whitespace, digits, whitespace, digits.
    let i = at - 1;
    while (i >= 0 && at - i < 8 && isSpace(text.charCodeAt(i))) i -= 1;
    const generationEnd = i + 1;
    while (i >= 0 && generationEnd - i <= 6 && isDigit(text.charCodeAt(i)))
      i -= 1;
    const generation = text.slice(i + 1, generationEnd);
    if (generation === '') continue;
    while (i >= 0 && isSpace(text.charCodeAt(i))) i -= 1;
    const numberEnd = i + 1;
    while (i >= 0 && numberEnd - i <= 10 && isDigit(text.charCodeAt(i))) i -= 1;
    const number = text.slice(i + 1, numberEnd);
    if (number === '') continue;
    out.set(Number(number) * 65536 + (Number(generation) & 0xffff), body.value);
  }
  return out;
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

/** The largest size any decoder chain reaches on the data, or past `limit`. */
async function largestExpansion(
  span: Uint8Array,
  limit: number
): Promise<number> {
  let best = 0;
  const wrapped: Uint8Array[] = [span];
  if (looksLikeHex(span)) wrapped.push(hexDecode(span));
  if (looksLikeAscii85(span)) {
    const decoded = ascii85Decode(span, limit);
    if (decoded === undefined) return limit + 1;
    wrapped.push(decoded);
  }
  for (const input of wrapped) {
    const flate = await flateChain(input, limit);
    if (flate > limit) return flate;
    best = Math.max(
      best,
      flate,
      lzwLength(input, 1, limit),
      lzwLength(input, 0, limit),
      runLengthLength(input, limit)
    );
    if (best > limit) return best;
  }
  return best;
}

/** A zlib header: deflate, a window up to 32 kB, no preset dictionary. */
function hasZlibHeader(data: Uint8Array): boolean {
  const cmf = data[0];
  const flg = data[1];
  if (cmf === undefined || flg === undefined) return false;
  if ((cmf & 0x0f) !== 8 || cmf >> 4 > 7 || (flg & 0x20) !== 0) return false;
  // Block type 3 is reserved; no stream starts with it.
  if (((data[2] ?? 0) & 6) === 6) return false;
  return ((cmf << 8) | flg) % 31 === 0;
}

/** Flate, and Flate inside Flate: each layer is as large as the one before. */
async function flateChain(data: Uint8Array, limit: number): Promise<number> {
  let best = 0;
  let current = data;
  for (
    let depth = 0;
    depth < MAX_FLATE_DEPTH && hasZlibHeader(current);
    depth += 1
  ) {
    const inflated = await inflate(current, limit);
    if (inflated === undefined) return limit + 1;
    best = Math.max(best, inflated.length);
    current = inflated;
  }
  return best;
}

/** Whether the data opens like ASCIIHex: a run of hex digits. */
function looksLikeHex(data: Uint8Array): boolean {
  let seen = 0;
  for (let i = 0; i < data.length && seen < 8; i += 1) {
    const byte = data[i] as number;
    if (isSpace(byte)) continue;
    if (!isHexDigit(byte)) return false;
    seen += 1;
  }
  return seen >= 4;
}

function isHexDigit(byte: number): boolean {
  return (
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x46) ||
    (byte >= 0x61 && byte <= 0x66)
  );
}

/** Whether the data opens like ASCII85: five characters of its alphabet. */
function looksLikeAscii85(data: Uint8Array): boolean {
  let i = 0;
  if (data[0] === 0x3c && data[1] === 0x7e) i = 2;
  let seen = 0;
  for (; i < data.length && seen < 5; i += 1) {
    const byte = data[i] as number;
    if (isSpace(byte)) continue;
    if (byte === 0x7a) return true;
    if (byte < 0x21 || byte > 0x75) return false;
    seen += 1;
  }
  return seen >= 2;
}

/** Inflates up to `limit` bytes; `undefined` once the output would pass it. */
async function inflate(
  data: Uint8Array,
  limit: number
): Promise<Uint8Array | undefined> {
  try {
    // Synchronous for the common case: a stream object per candidate is what
    // makes a document of fifty thousand small streams slow. Tolerant of a
    // truncated stream, like pdf.js is.
    return inflateSync(data, {
      maxOutputLength: limit + 1,
      finishFlush: constants.Z_SYNC_FLUSH,
    });
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'ERR_BUFFER_TOO_LARGE')
      return undefined;
  }
  // A corrupt stream yields what it decoded before the bad byte, which is also
  // what pdf.js gets from it, and only the streaming form hands that over.
  return inflateStreaming(data, limit);
}

function inflateStreaming(
  data: Uint8Array,
  limit: number
): Promise<Uint8Array | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let produced = 0;
    let settled = false;
    const stream = createInflate();
    const finish = (value: Uint8Array | undefined): void => {
      if (settled) return;
      settled = true;
      stream.destroy();
      resolve(value);
    };
    stream.on('data', (chunk: Buffer) => {
      if (settled) return;
      produced += chunk.length;
      if (produced > limit) {
        finish(undefined);
        return;
      }
      chunks.push(chunk);
    });
    // The listener stays attached after settling so a late error has
    // somewhere to go.
    stream.on('error', () => finish(Buffer.concat(chunks)));
    stream.on('end', () => finish(Buffer.concat(chunks)));
    stream.end(data);
  });
}

/**
 * Output length of a PDF LZW stream, without building a single string.
 *
 * Every dictionary entry is one byte longer than the entry it extends, so the
 * length of any code is known from lengths alone — which is all the question
 * needs. Codes are 9 to 12 bits, MSB first; 256 clears, 257 ends; the width
 * grows one code early under the default `EarlyChange`.
 */
function lzwLength(
  data: Uint8Array,
  earlyChange: number,
  limit: number
): number {
  let produced = 0;
  let bits = 0;
  let held = 0;
  let pos = 0;
  let width = 9;
  let lengths: number[] = [];
  let previous = 0;
  let hasPrevious = false;

  while (produced <= limit) {
    while (held < width && pos < data.length) {
      bits = (bits << 8) | (data[pos] as number);
      pos += 1;
      held += 8;
    }
    if (held < width) break;
    const code = (bits >>> (held - width)) & ((1 << width) - 1);
    held -= width;
    bits &= (1 << held) - 1;

    if (code === 256) {
      lengths = [];
      width = 9;
      hasPrevious = false;
      continue;
    }
    if (code === 257) break;

    let length: number;
    if (code < 256) length = 1;
    else if (code - 258 < lengths.length)
      length = lengths[code - 258] as number;
    else if (code - 258 === lengths.length && hasPrevious)
      length = previous + 1;
    else break;

    produced += length;
    if (hasPrevious) lengths.push(previous + 1);
    previous = length;
    hasPrevious = true;
    if (width < 12 && 258 + lengths.length + earlyChange >= 1 << width)
      width += 1;
  }
  return produced;
}

/** Output length of a RunLength stream. */
function runLengthLength(data: Uint8Array, limit: number): number {
  let produced = 0;
  let i = 0;
  while (i < data.length && produced <= limit) {
    const marker = data[i] as number;
    i += 1;
    if (marker === 128) break;
    if (marker < 128) {
      produced += marker + 1;
      i += marker + 1;
    } else {
      produced += 257 - marker;
      i += 1;
    }
  }
  return produced;
}

function hexDecode(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(data.length / 2));
  let n = 0;
  let pending = -1;
  for (const byte of data) {
    if (byte === 0x3e) break; // '>'
    const digit =
      byte >= 0x30 && byte <= 0x39
        ? byte - 0x30
        : byte >= 0x41 && byte <= 0x46
          ? byte - 0x37
          : byte >= 0x61 && byte <= 0x66
            ? byte - 0x57
            : -1;
    if (digit < 0) continue;
    if (pending < 0) {
      pending = digit;
    } else {
      out[n] = pending * 16 + digit;
      n += 1;
      pending = -1;
    }
  }
  if (pending >= 0) {
    out[n] = pending * 16;
    n += 1;
  }
  return out.subarray(0, n);
}

/**
 * ASCII85, sized by what it produces. `z` stands for four zero bytes and is a
 * single input byte, so the output of a run of them is four times the input —
 * a bound derived from the length of five-character groups clamps, and the
 * tail of the stream is then never decoded, let alone measured. Counted first,
 * allocated once; `undefined` when the result would pass `limit`, which for a
 * stage in front of another decoder is already the answer.
 */
function ascii85Decode(
  data: Uint8Array,
  limit: number
): Uint8Array | undefined {
  let start = 0;
  if (data[0] === 0x3c && data[1] === 0x7e) start = 2; // '<~'

  let size = 0;
  let count = 0;
  for (let i = start; i < data.length; i += 1) {
    const byte = data[i] as number;
    if (byte === 0x7e) break; // '~' of '~>'
    if (byte === 0x7a && count === 0) {
      size += 4;
    } else if (byte >= 0x21 && byte <= 0x75) {
      count += 1;
      if (count === 5) {
        size += 4;
        count = 0;
      }
    }
    if (size > limit) return undefined;
  }
  if (count > 1) size += count - 1;

  const out = new Uint8Array(size);
  let n = 0;
  let value = 0;
  count = 0;
  const emit = (digits: number): void => {
    // Padded with the highest digit, as the format says.
    let v = value;
    for (let k = digits; k < 5; k += 1) v = v * 85 + 84;
    const bytes = [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    for (let k = 0; k < digits - 1; k += 1) {
      out[n] = bytes[k] as number;
      n += 1;
    }
  };
  for (let i = start; i < data.length; i += 1) {
    const byte = data[i] as number;
    if (byte === 0x7e) break;
    if (byte === 0x7a && count === 0) {
      n += 4; // already zero
      continue;
    }
    if (byte < 0x21 || byte > 0x75) continue;
    value = value * 85 + (byte - 0x21);
    count += 1;
    if (count === 5) {
      const v = value >>> 0;
      out[n] = v >>> 24;
      out[n + 1] = (v >>> 16) & 255;
      out[n + 2] = (v >>> 8) & 255;
      out[n + 3] = v & 255;
      n += 4;
      value = 0;
      count = 0;
    }
  }
  if (count > 1) emit(count);
  return out;
}
