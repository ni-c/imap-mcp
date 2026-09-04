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
 * worker is also started with its stdout detached, because one guard is not a
 * guard.
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
 * The API surface used here is deliberately four calls wide — `getDocument`,
 * `getPage`, `getTextContent`, `destroy` — and it must stay that way.
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
    let clipped = declared > pageCount;
    let hiddenRuns = 0;
    let totalRuns = 0;

    // Sequentially, not `Promise.all` over the page count — which is what
    // unpdf's own `extractText` does. That form allocates an array as long as
    // the document claims to be and holds every page's text content live at
    // once, both sized by a number the sender wrote.
    for (let page = 1; page <= pageCount && !clipped; page += 1) {
      const content = await (await pdf.getPage(page)).getTextContent();
      const line: string[] = [];
      for (const item of content.items) {
        if (!('str' in item)) continue;
        totalRuns += 1;
        if (isHidden(item)) hiddenRuns += 1;
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
    // Releases the parsing state. The thread is about to be torn down anyway,
    // but a document that fails on page 3 of 100 should not hold its object
    // graph while the remaining pages are abandoned. `destroy` is on the
    // loading task, not on the document proxy — the proxy only has `cleanup`,
    // which keeps the transport alive.
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
 */
function isHidden(item: { transform?: unknown; height?: number }): boolean {
  const t = item.transform;
  if (Array.isArray(t) && t.length >= 6) {
    const x = Number(t[4]);
    const y = Number(t[5]);
    // A negative origin means the run starts outside the page. Measured against
    // pdf.js 6: a run placed *entirely* off the page produces no text item at
    // all, so this catches the half that hangs over an edge and the other half
    // never arrives — which is the better outcome and not one to undo.
    if (Number.isFinite(x) && Number.isFinite(y) && (x < 0 || y < 0)) {
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
