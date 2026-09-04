import { zipSync } from 'fflate';

/**
 * Builders for the document formats the extractor reads.
 *
 * Built rather than checked in, for the reason the rest of this suite builds
 * its MIME by hand: every hostile case below is a *variation* — a page count
 * that lies, an encryption dictionary, a central directory patched to declare
 * four gigabytes — and a base64 blob gives you one document and no variations.
 * A fixture file would also be a binary in a repository that ships none.
 */

interface PdfOptions {
  text?: string;
  /** Written into /Count regardless of how many pages the tree really has. */
  declaredPages?: number;
  /** Font size, in points. Small values are how text hides from a reader. */
  fontSize?: number;
  /** Text placement. Negative coordinates put it off the page. */
  at?: [number, number];
  /** Adds an /Encrypt reference to the trailer. */
  encrypted?: boolean;
  /** Draws a filled rectangle instead of any text at all. */
  imageOnly?: boolean;
}

/**
 * A real, minimal PDF that pdf.js extracts text from.
 *
 * The font is one of the standard fourteen, so there is no embedded font
 * program — which is exactly why this works in a dependency tree where
 * `pdfjs-dist` is absent and `standardFontDataUrl` is deliberately unset.
 */
export function buildPdf(options: PdfOptions = {}): Buffer {
  const {
    text = 'Rechnung 1200,00 EUR',
    declaredPages,
    fontSize = 24,
    at = [72, 720],
    encrypted = false,
    imageOnly = false,
  } = options;

  const stream = imageOnly
    ? '0 0 100 100 re f'
    : `BT /F1 ${fontSize} Tf ${at[0]} ${at[1]} Td (${escapePdf(text)}) Tj ET`;

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [3 0 R] /Count ${declaredPages ?? 1} >>`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  if (encrypted) {
    // Not cryptographically real, and it does not need to be: pdf.js builds its
    // cipher factory and rejects with a PasswordException before validating
    // anything, which is the branch under test.
    objects.push(
      '<< /Filter /Standard /V 2 /R 3 /Length 128 /P -1 ' +
        `/O <${'ab'.repeat(32)}> /U <${'cd'.repeat(32)}> >>`
    );
  }

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const startxref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R` +
    (encrypted ? ` /Encrypt ${objects.length} 0 R /ID [<00> <00>]` : '') +
    ` >>\nstartxref\n${startxref}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

function escapePdf(text: string): string {
  return text.replace(/([\\()])/g, '\\$1');
}

const XML = '<?xml version="1.0" encoding="UTF-8"?>';
const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** A .docx whose body is the given paragraphs. */
export function buildDocx(
  paragraphs: string[],
  options: { vanish?: boolean; fieldCode?: string } = {}
): Buffer {
  const body = paragraphs
    .map(
      (paragraph) =>
        '<w:p><w:r>' +
        (options.vanish ? '<w:rPr><w:vanish/></w:rPr>' : '') +
        `<w:t>${escapeXml(paragraph)}</w:t></w:r></w:p>`
    )
    .join('');
  const field =
    options.fieldCode === undefined
      ? ''
      : `<w:p><w:r><w:instrText>${escapeXml(options.fieldCode)}</w:instrText></w:r></w:p>`;
  return zip({
    'word/document.xml': `${XML}<w:document ${W_NS}><w:body>${field}${body}</w:body></w:document>`,
  });
}

/** A .docx carrying a raw `word/document.xml`, for the malformed cases. */
export function buildDocxRaw(documentXml: string): Buffer {
  return zip({ 'word/document.xml': documentXml });
}

interface XlsxOptions {
  /**
   * Put the cell values in `xl/sharedStrings.xml` and reference them by index,
   * which is what Excel itself does. The inline form is legal and much rarer,
   * so both are worth building.
   */
  shared?: boolean;
  /** Omit `xl/_rels/workbook.xml.rels`, forcing the fallback naming. */
  withoutRels?: boolean;
  /** Start each row at this column letter, leaving the ones before it empty. */
  startColumn?: number;
}

/** An .xlsx, with the cells either inline or in the shared-string table. */
export function buildXlsx(
  sheets: { name: string; rows: string[][] }[],
  options: XlsxOptions = {}
): Buffer {
  const files: Record<string, Buffer> = {};
  const relationships: string[] = [];
  const sheetTags: string[] = [];
  const shared: string[] = [];
  const indexOfShared = (value: string): number => {
    const existing = shared.indexOf(value);
    if (existing >= 0) return existing;
    shared.push(value);
    return shared.length - 1;
  };

  sheets.forEach((sheet, index) => {
    const id = `rId${index + 1}`;
    const path = `sheet${index + 1}.xml`;
    relationships.push(
      `<Relationship Id="${id}" Target="worksheets/${path}" ` +
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/>'
    );
    sheetTags.push(
      `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="${id}"/>`
    );
    const rows = sheet.rows
      .map((cells, rowIndex) => {
        const columns = cells
          .map((value, column) => {
            const reference = `${letter(column + (options.startColumn ?? 0))}${rowIndex + 1}`;
            return options.shared === true
              ? `<c r="${reference}" t="s"><v>${indexOfShared(value)}</v></c>`
              : `<c r="${reference}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
          })
          .join('');
        return `<row r="${rowIndex + 1}">${columns}</row>`;
      })
      .join('');
    files[`xl/worksheets/${path}`] = Buffer.from(
      `${XML}<worksheet><sheetData>${rows}</sheetData></worksheet>`
    );
  });

  files['xl/workbook.xml'] = Buffer.from(
    `${XML}<workbook><sheets>${sheetTags.join('')}</sheets></workbook>`
  );
  if (options.withoutRels !== true) {
    files['xl/_rels/workbook.xml.rels'] = Buffer.from(
      `${XML}<Relationships>${relationships.join('')}</Relationships>`
    );
  }
  if (options.shared === true) {
    files['xl/sharedStrings.xml'] = Buffer.from(
      `${XML}<sst>${shared
        .map((value) => `<si><t>${escapeXml(value)}</t></si>`)
        .join('')}</sst>`
    );
  }
  return zip(files);
}

/** An .ods with one table. `repeat` sets number-columns-repeated on a cell. */
export function buildOds(
  sheets: { name: string; rows: string[][] }[],
  options: { trailingRepeat?: number } = {}
): Buffer {
  const tables = sheets
    .map((sheet) => {
      const rows = sheet.rows
        .map((cells) => {
          const columns = cells
            .map(
              (value) =>
                `<table:table-cell><text:p>${escapeXml(value)}</text:p></table:table-cell>`
            )
            .join('');
          const padding =
            options.trailingRepeat === undefined
              ? ''
              : `<table:table-cell table:number-columns-repeated="${options.trailingRepeat}"/>`;
          return `<table:table-row>${columns}${padding}</table:table-row>`;
        })
        .join('');
      return `<table:table table:name="${escapeXml(sheet.name)}">${rows}</table:table>`;
    })
    .join('');
  return zip({
    'content.xml': `${XML}<office:document-content>${tables}</office:document-content>`,
  });
}

/** An .odt whose body is the given paragraphs. */
export function buildOdt(paragraphs: string[]): Buffer {
  const body = paragraphs
    .map((paragraph) => `<text:p>${escapeXml(paragraph)}</text:p>`)
    .join('');
  return zip({
    'content.xml': `${XML}<office:document-content><office:body>${body}</office:body></office:document-content>`,
  });
}

/** A .pptx with one slide per entry. */
export function buildPptx(slides: string[]): Buffer {
  const files: Record<string, Buffer> = {};
  slides.forEach((text, index) => {
    files[`ppt/slides/slide${index + 1}.xml`] = Buffer.from(
      `${XML}<p:sld><p:cSld><p:spTree><p:sp><p:txBody>` +
        `<a:p><a:r><a:t>${escapeXml(text)}</a:t></a:r></a:p>` +
        '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>'
    );
  });
  return zip(files);
}

export function zip(files: Record<string, Buffer | string>): Buffer {
  const data: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) {
    data[name] = typeof content === 'string' ? Buffer.from(content) : content;
  }
  return Buffer.from(zipSync(data));
}

const CENTRAL_DIRECTORY = Buffer.from([0x50, 0x4b, 0x01, 0x02]);

/**
 * Rewrites the declared uncompressed size in every central-directory record.
 *
 * This is the number `unzipSync` sizes its output buffer from, and nothing
 * checks it against the data. Patching it is how a three-hundred-byte archive
 * claims to hold four gigabytes.
 */
export function patchDeclaredSize(archive: Buffer, size: number): Buffer {
  const patched = Buffer.from(archive);
  let at = patched.indexOf(CENTRAL_DIRECTORY);
  while (at >= 0) {
    patched.writeUInt32LE(size, at + 24);
    at = patched.indexOf(CENTRAL_DIRECTORY, at + 4);
  }
  return patched;
}

function letter(index: number): string {
  let out = '';
  let n = index;
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
