import type { ExtractKind, ExtractResponse } from './types.js';

/**
 * Turns markup into readable text. Injected rather than imported.
 *
 * `htmlToText` lives in `../analyze.ts`, and this module is reached from the
 * extraction worker, which Node loads directly — where a `../analyze.js`
 * specifier does not resolve to the `.ts` beside it. Passing the function in
 * keeps this file free of relative value imports, which is the property that
 * lets it run in the worker at all. It also makes the seam explicit: the tests
 * hand it the same `htmlToText` the worker does.
 */
export type MarkupToText = (markup: string, maxChars: number) => string;

/**
 * Central-directory entries examined at all. A real .docx has eight to fifteen.
 */
const MAX_ZIP_ENTRIES = 512;

/**
 * How far the cell walk may scan for a closing tag it never finds, per sheet.
 * Same reasoning as the closer budget in `htmlToText`: bound the product, not
 * each scan.
 */
const CLOSER_SCAN_BUDGET_FACTOR = 4;

const MAX_SHEETS = 32;
const MAX_ROWS = 5_000;
const MAX_COLS = 128;
const MAX_SLIDES = 200;

/**
 * Ceiling on a `number-columns-repeated` / `number-rows-repeated` count.
 *
 * LibreOffice writes `16384` on the trailing empty cell of every single row.
 * Honouring that verbatim turns a 40 kB spreadsheet into hundreds of megabytes
 * of tab characters, which is a denial of service written by a well-behaved
 * office suite rather than by an attacker.
 */
const MAX_REPEAT = 256;

/** A spreadsheet cell holds a value, not a chapter. */
const MAX_CELL_CHARS = 4_096;

/**
 * Reads the text of an OOXML or OpenDocument container.
 *
 * The whole defence lives in the `filter` callback below, and it is worth
 * saying why that specific place. `unzipSync` inflates an entry into a buffer
 * sized by the *declared* uncompressed size out of the central directory — a
 * number the sender chose, checked against nothing. The filter is the last
 * point before that allocation, and returning `false` there means the entry is
 * never inflated and never sized.
 *
 * Measured on fflate 0.8.3: a declared size far past the real one does not blow
 * up resident memory on Linux, because the allocation is virtual and untouched
 * pages cost nothing. The guard stays regardless — it is free, it is the only
 * thing standing between an *honest* high-ratio entry and its real expansion,
 * and a host that does not overcommit would pay the full price.
 *
 * This never recurses. An entry that is itself an archive is not in the name
 * allowlist, so a nested bomb is not descended into; that is a property to keep
 * rather than an omission to fix.
 */
export async function extractZipDocument(
  kind: Exclude<ExtractKind, 'pdf'>,
  bytes: Uint8Array,
  maxChars: number,
  toText: MarkupToText
): Promise<ExtractResponse> {
  const { unzipSync, strFromU8 } = await import('fflate');

  let seen = 0;
  let budget = maxChars;
  let tooManyParts = false;
  let entries;

  try {
    entries = unzipSync(bytes, {
      filter: (file) => {
        if (tooManyParts) return false;
        seen += 1;
        if (seen > MAX_ZIP_ENTRIES) {
          tooManyParts = true;
          return false;
        }
        // Nothing here writes to disk, so this is not a traversal fix. The
        // paths below are matched by prefix, and `xl/worksheets/../../x.xml`
        // would match one of them; refusing the name is cheaper than reasoning
        // about what it would mean. It also disposes of an entry called
        // `__proto__`, which fflate would happily use as an object key.
        if (!isSafeName(file.name)) return false;
        if (!wanted(kind, file.name)) return false;
        // Deflate and stored only. fflate throws on any other method once the
        // filter has said yes, and an error is a worse answer than a skip.
        if (file.compression !== 0 && file.compression !== 8) return false;
        if (file.originalSize > budget) return false;
        budget -= file.originalSize;
        return true;
      },
    });
  } catch {
    // Truncated archive, bad signature, unsupported method. The exception text
    // quotes the file and is never passed on.
    return { ok: false, reason: 'corrupt' };
  }

  if (tooManyParts) return { ok: false, reason: 'too-many-parts' };

  const read = (name: string): string | undefined => {
    const raw = entries[name];
    return raw === undefined ? undefined : strFromU8(raw);
  };

  if (kind === 'xlsx')
    return sheetsResult(readXlsx(entries, strFromU8, maxChars));
  if (kind === 'ods') {
    const content = read('content.xml');
    if (content === undefined) return { ok: false, reason: 'not-a-document' };
    return sheetsResult(readOds(content, maxChars, toText));
  }

  const parts: string[] = [];
  let units = 0;

  if (kind === 'docx') {
    const document = read('word/document.xml');
    if (document === undefined) return { ok: false, reason: 'not-a-document' };
    parts.push(toText(document, maxChars));
  } else if (kind === 'odt') {
    const content = read('content.xml');
    if (content === undefined) return { ok: false, reason: 'not-a-document' };
    parts.push(toText(content, maxChars));
  } else {
    // pptx: one heading per slide, in slide order rather than in whatever order
    // the archive happens to list them.
    const slides = Object.keys(entries)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => slideNumber(a) - slideNumber(b))
      .slice(0, MAX_SLIDES);
    if (slides.length === 0) return { ok: false, reason: 'not-a-document' };
    for (const name of slides) {
      units += 1;
      parts.push(
        `== Slide ${units} ==\n${toText(read(name) ?? '', maxChars)}\n`
      );
    }
  }

  const joined = parts.join('');
  const text = joined.slice(0, maxChars);
  if (text.trim() === '') return { ok: false, reason: 'no-text-layer' };
  return {
    ok: true,
    text,
    ...(kind === 'pptx'
      ? { unitLabel: 'slides' as const, unitCount: units }
      : {}),
    clipped: joined.length > text.length,
  };
}

interface Sheet {
  name: string;
  rows: string[][];
}

function sheetsResult(sheets: Sheet[] | undefined): ExtractResponse {
  if (sheets === undefined) return { ok: false, reason: 'not-a-document' };
  const text = sheets
    .map(
      (sheet) =>
        `== Sheet: ${sheet.name} ==\n` +
        sheet.rows.map((row) => row.join('\t')).join('\n')
    )
    .join('\n\n');
  if (text.trim() === '') return { ok: false, reason: 'no-text-layer' };
  return {
    ok: true,
    text,
    unitLabel: 'sheets',
    unitCount: sheets.length,
    clipped: false,
  };
}

/* ------------------------------------------------------------------ xlsx -- */

function readXlsx(
  entries: Record<string, Uint8Array>,
  strFromU8: (data: Uint8Array) => string,
  maxChars: number
): Sheet[] | undefined {
  const at = (name: string): string | undefined => {
    const raw = entries[name];
    return raw === undefined ? undefined : strFromU8(raw);
  };

  const shared = sharedStrings(at('xl/sharedStrings.xml'));
  const order = sheetOrder(
    at('xl/workbook.xml'),
    at('xl/_rels/workbook.xml.rels')
  );

  const available = Object.keys(entries)
    .filter((name) => /^xl\/worksheets\/[^/]+\.xml$/.test(name))
    .sort();
  if (available.length === 0) return undefined;

  // The rels file is how a tab's name is tied to its file, and `sheet1.xml` is
  // a convention rather than a rule — it is not necessarily the first tab. When
  // the mapping is missing or does not resolve, fall back to archive order with
  // generated names rather than presenting a guess as a fact.
  const planned =
    order.length > 0
      ? order.filter((entry) => available.includes(entry.path))
      : [];
  const plan =
    planned.length > 0
      ? planned
      : available.map((path, index) => ({ name: `Sheet ${index + 1}`, path }));

  let budget = maxChars;
  const sheets: Sheet[] = [];
  for (const entry of plan.slice(0, MAX_SHEETS)) {
    if (budget <= 0) break;
    const xml = at(entry.path);
    if (xml === undefined) continue;
    const rows = worksheetRows(xml, shared);
    budget -= rows.reduce((sum, row) => sum + row.join('\t').length + 1, 0);
    sheets.push({ name: entry.name, rows });
  }
  return sheets;
}

/** `<si>` entries in document order; a run-split string is its `<t>` pieces. */
function sharedStrings(xml: string | undefined): string[] {
  if (xml === undefined) return [];
  const out: string[] = [];
  let i = 0;
  while (out.length < 200_000) {
    const open = xml.indexOf('<si>', i);
    if (open < 0) break;
    const close = xml.indexOf('</si>', open);
    if (close < 0) break;
    out.push(textRuns(xml.slice(open, close)));
    i = close + 5;
  }
  return out;
}

/** Concatenates every `<t>…</t>` in a fragment. Forward-only. */
function textRuns(fragment: string): string {
  const parts: string[] = [];
  let i = 0;
  for (;;) {
    const open = fragment.indexOf('<t', i);
    if (open < 0) break;
    const gt = fragment.indexOf('>', open);
    if (gt < 0) break;
    // `<t>` and `<t xml:space="preserve">`, but not `<tab/>` or another element
    // whose name merely starts with a t.
    const head = fragment.slice(open + 2, gt);
    if (head !== '' && !head.startsWith(' ') && !head.startsWith('/')) {
      i = gt + 1;
      continue;
    }
    if (fragment[gt - 1] === '/') {
      i = gt + 1;
      continue;
    }
    const close = fragment.indexOf('</t>', gt);
    if (close < 0) break;
    parts.push(decodeEntities(fragment.slice(gt + 1, close)));
    i = close + 4;
  }
  return parts.join('');
}

interface SheetRef {
  name: string;
  path: string;
}

function sheetOrder(
  workbook: string | undefined,
  rels: string | undefined
): SheetRef[] {
  if (workbook === undefined) return [];
  const targets = new Map<string, string>();
  if (rels !== undefined) {
    const pattern = /<Relationship\b[^>]*>/g;
    for (
      let match = pattern.exec(rels);
      match !== null && targets.size < MAX_SHEETS * 4;
      match = pattern.exec(rels)
    ) {
      const id = attribute(match[0], 'Id');
      const target = attribute(match[0], 'Target');
      if (id !== undefined && target !== undefined) targets.set(id, target);
    }
  }

  const out: SheetRef[] = [];
  const pattern = /<sheet\b[^>]*>/g;
  for (
    let match = pattern.exec(workbook);
    match !== null && out.length < MAX_SHEETS;
    match = pattern.exec(workbook)
  ) {
    const name = attribute(match[0], 'name');
    const id = attribute(match[0], 'r:id') ?? attribute(match[0], 'id');
    if (name === undefined || id === undefined) continue;
    const target = targets.get(id);
    if (target === undefined) continue;
    const path = `xl/${target.replace(/^\/?xl\//, '').replace(/^\.\//, '')}`;
    out.push({ name: decodeEntities(name), path });
  }
  return out;
}

function worksheetRows(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  let budget = xml.length * CLOSER_SCAN_BUDGET_FACTOR;
  let i = 0;
  let row: string[] | undefined;

  while (i < xml.length && rows.length < MAX_ROWS) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) break;
    const gt = xml.indexOf('>', lt);
    if (gt < 0) break;
    const tag = xml.slice(lt, gt + 1);

    if (tag.startsWith('<row')) {
      row = [];
      i = gt + 1;
      continue;
    }
    if (tag.startsWith('</row')) {
      if (row !== undefined) rows.push(row);
      row = undefined;
      i = gt + 1;
      continue;
    }
    if (!tag.startsWith('<c ') && tag !== '<c>') {
      i = gt + 1;
      continue;
    }

    const selfClosing = tag.endsWith('/>');
    let end = gt + 1;
    let body = '';
    if (!selfClosing) {
      const close = xml.indexOf('</c>', gt);
      if (close < 0 || budget <= 0) break;
      budget -= close - gt;
      body = xml.slice(gt + 1, close);
      end = close + 4;
    }

    if (row !== undefined && row.length < MAX_COLS) {
      const column = columnIndex(attribute(tag, 'r'));
      // A cell reference places the value, so a gap in the row stays a gap
      // rather than shifting every later column one to the left.
      if (column !== undefined) {
        while (row.length < Math.min(column, MAX_COLS)) row.push('');
      }
      row.push(cellValue(tag, body, shared));
    }
    i = end;
  }
  if (row !== undefined) rows.push(row);
  return rows;
}

function cellValue(tag: string, body: string, shared: string[]): string {
  const type = attribute(tag, 't');
  if (type === 'inlineStr') return clean(textRuns(body));
  if (type === 's') {
    const index = Number(between(body, '<v>', '</v>') ?? '');
    return Number.isInteger(index) ? clean(shared[index] ?? '') : '';
  }
  const value = between(body, '<v>', '</v>');
  if (value !== undefined) return clean(decodeEntities(value));
  return clean(textRuns(body));
}

/** `B` → 1, `AA4` → 26. The row part is ignored; the walk supplies it. */
function columnIndex(reference: string | undefined): number | undefined {
  if (reference === undefined) return undefined;
  const letters = /^([A-Za-z]+)/.exec(reference)?.[1];
  if (letters === undefined || letters.length > 3) return undefined;
  let index = 0;
  for (const character of letters.toUpperCase()) {
    index = index * 26 + (character.charCodeAt(0) - 64);
  }
  return index - 1;
}

/* -------------------------------------------------------------------- ods -- */

function readOds(xml: string, maxChars: number, toText: MarkupToText): Sheet[] {
  const sheets: Sheet[] = [];
  let budget = maxChars;
  let i = 0;

  while (sheets.length < MAX_SHEETS && budget > 0) {
    const open = xml.indexOf('<table:table ', i);
    if (open < 0) break;
    const gt = xml.indexOf('>', open);
    if (gt < 0) break;
    const name = decodeEntities(
      attribute(xml.slice(open, gt + 1), 'table:name') ??
        `Sheet ${sheets.length + 1}`
    );
    const close = xml.indexOf('</table:table>', gt);
    const body = xml.slice(gt + 1, close < 0 ? xml.length : close);
    const rows = odsRows(body, toText);
    budget -= rows.reduce((sum, row) => sum + row.join('\t').length + 1, 0);
    sheets.push({ name, rows });
    if (close < 0) break;
    i = close + 14;
  }
  return sheets;
}

function odsRows(xml: string, toText: MarkupToText): string[][] {
  const rows: string[][] = [];
  let i = 0;

  while (i < xml.length && rows.length < MAX_ROWS) {
    const open = xml.indexOf('<table:table-row', i);
    if (open < 0) break;
    const close = xml.indexOf('</table:table-row>', open);
    const body = xml.slice(open, close < 0 ? xml.length : close);
    const row: string[] = [];

    let j = 0;
    while (row.length < MAX_COLS) {
      const cell = body.indexOf('<table:table-cell', j);
      if (cell < 0) break;
      const gt = body.indexOf('>', cell);
      if (gt < 0) break;
      const tag = body.slice(cell, gt + 1);
      const cellClose = tag.endsWith('/>')
        ? -1
        : body.indexOf('</table:table-cell>', gt);
      // An OpenDocument cell holds `<text:p>`, not the `<t>` of OOXML, so the
      // markup walk does the reading here rather than the run collector.
      // Trimmed, because the markup walk emits a space for every tag it drops
      // and a cell padded with them stops lining up as a column.
      const value =
        cellClose < 0
          ? ''
          : clean(toText(body.slice(gt + 1, cellClose), MAX_CELL_CHARS)).trim();
      // Clamped, and this is the guard that matters most in this file: every
      // row an office suite writes ends in a cell repeated 16 384 times.
      const repeat = Math.min(
        Math.max(
          Number(attribute(tag, 'table:number-columns-repeated') ?? '1') || 1,
          1
        ),
        MAX_REPEAT
      );
      for (let n = 0; n < repeat && row.length < MAX_COLS; n += 1)
        row.push(value);
      j = cellClose < 0 ? gt + 1 : cellClose + 19;
    }

    // Trailing empty cells are padding, not data.
    while (row.length > 0 && row[row.length - 1] === '') row.pop();
    rows.push(row);
    if (close < 0) break;
    i = close + 18;
  }
  // The same padding, one dimension up.
  while (rows.length > 0 && (rows[rows.length - 1] as string[]).length === 0)
    rows.pop();
  return rows;
}

/* ------------------------------------------------------------------ misc -- */

/**
 * Entries this server will inflate, by kind.
 *
 * An allowlist rather than a denylist, checked before anything is decompressed.
 * Everything an attacker could add to a container — a second archive, a font, a
 * media file, an entry with a hostile name — is simply never read.
 */
function wanted(kind: Exclude<ExtractKind, 'pdf'>, name: string): boolean {
  if (kind === 'docx') return name === 'word/document.xml';
  if (kind === 'odt' || kind === 'ods') return name === 'content.xml';
  if (kind === 'pptx') return /^ppt\/slides\/slide\d+\.xml$/.test(name);
  return (
    name === 'xl/workbook.xml' ||
    name === 'xl/_rels/workbook.xml.rels' ||
    name === 'xl/sharedStrings.xml' ||
    /^xl\/worksheets\/[^/]+\.xml$/.test(name)
  );
}

function isSafeName(name: string): boolean {
  if (name.startsWith('/') || name.includes('\\')) return false;
  if (/^[A-Za-z]:/.test(name)) return false;
  return !name.split('/').includes('..');
}

function slideNumber(name: string): number {
  return Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);
}

function attribute(tag: string, name: string): string | undefined {
  const pattern = new RegExp(
    `\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*"([^"]*)"`
  );
  return pattern.exec(tag)?.[1];
}

function between(
  source: string,
  open: string,
  close: string
): string | undefined {
  const start = source.indexOf(open);
  if (start < 0) return undefined;
  const end = source.indexOf(close, start + open.length);
  if (end < 0) return undefined;
  return source.slice(start + open.length, end);
}

/**
 * A tab or a newline inside a cell would end the column or the row it is in,
 * and the reader has no way to tell that from real structure.
 */
function clean(value: string): string {
  return value.replace(/[\t\r\n]+/g, ' ');
}

/**
 * The five predefined XML entities and bounded numeric references.
 *
 * Deliberately nothing else. There is no entity table here, so a document that
 * declares `<!ENTITY lol …>` gets its `&lol;` back as four literal characters —
 * which is what makes billion-laughs and `SYSTEM "file:///etc/passwd"` non-events
 * rather than defended-against attacks.
 */
function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (match, hex: string) =>
      codePoint(parseInt(hex, 16), match)
    )
    .replace(/&#(\d{1,7});/g, (match, digits: string) =>
      codePoint(Number(digits), match)
    )
    .replace(/&amp;/g, '&');
}

/**
 * Same rule as `fromCodePoint` in `../analyze.ts`, and deliberately the same
 * answer: a reference nobody can render stays visible rather than becoming a
 * replacement character that reads as content. Duplicated rather than shared
 * because this module is reached from the worker, where a relative import of
 * `../analyze.js` does not resolve.
 */
function codePoint(value: number, original: string): string {
  if (!Number.isInteger(value) || value < 1 || value > 0x10ffff)
    return original;
  if (value >= 0xd800 && value <= 0xdfff) return original;
  return String.fromCodePoint(value);
}
