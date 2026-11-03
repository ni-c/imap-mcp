import { describe, expect, it } from 'vitest';

import { htmlToText } from '../src/analyze.js';
import { extractZipDocument } from '../src/extract/ooxml.js';
import { expandsTooFar } from '../src/extract/pdf.js';
import { zip } from './document-fixtures.js';

/**
 * Shapes that make a scan restart from the top for every occurrence of a
 * token: quadratic in the number of occurrences, and the occurrences are the
 * sender's to multiply. Each case is a file of ten megabytes or so built from a
 * unit a few dozen bytes long, and each must be answered in a fraction of a
 * second. The assertions are on time alone — the verdicts are covered where the
 * formats are.
 */
const TEN_MIB = 10 * 1024 * 1024;

function repeated(unit: string, size = TEN_MIB): Uint8Array {
  const text = unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  return new Uint8Array(Buffer.from(text, 'latin1'));
}

async function timed(work: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await work();
  return performance.now() - started;
}

/**
 * Growth, not wall-clock alone: CI runs these under v8 coverage, which makes a
 * tight loop an order of magnitude slower, so a fixed budget measures the
 * instrumentation. Four times the input may cost at most eight times the time
 * — linear is four, a restart per occurrence is sixteen — and the absolute
 * ceiling stays as the net for anything that hangs.
 */
async function expectLinear(
  work: (size: number) => Promise<unknown>
): Promise<void> {
  const small = await timed(() => work(TEN_MIB / 4));
  const large = await timed(() => work(TEN_MIB));
  expect(large).toBeLessThan(15_000);
  expect(large / Math.max(small, 25)).toBeLessThan(8);
}

const extract = (
  kind: Parameters<typeof extractZipDocument>[0],
  files: Record<string, string>
) =>
  extractZipDocument(kind, new Uint8Array(zip(files)), 1_000_000, htmlToText);

describe('the PDF pre-scan is linear in the number of streams', () => {
  const cases: Record<string, string> = {
    // 32 bytes: an object header, an empty dictionary, a three-byte stream.
    'object, stream and endstream in 32 bytes':
      '1 0 obj<<>>stream\nabc\nendstream\n',
    // A backward search for `obj` finds nothing and walks to the start.
    'streams with no object header in front of them':
      '\n<<>>stream\nabc\nendstream\n',
    // A lookup of `99 0 R` that never resolves is a scan of the whole file.
    'an indirect /Length that resolves to nothing':
      '1 0 obj<</Length 99 0 R>>stream\nx\nendstream\n',
    'an indirect /Length that resolves':
      '9 0 obj 1 endobj 1 0 obj<</Length 9 0 R>>stream\nx\nendstream\n',
    'a stream keyword that is never closed': '1 0 obj<<>>stream\nabcdef ',
    'nothing but stream keywords': '\nstream\n',
  };
  for (const [name, unit] of Object.entries(cases)) {
    it(`answers ${name} in linear time`, async () => {
      await expectLinear((size) => expandsTooFar(repeated(unit, size)));
    }, 40_000);
  }
});

describe('the OOXML readers are linear in the number of unclosed tags', () => {
  it('reads relationships that never close in under a second', async () => {
    const files = {
      'xl/workbook.xml':
        '<workbook><sheets><sheet name="A" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationship '.repeat(400_000),
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>',
    };
    expect(await timed(() => extract('xlsx', files))).toBeLessThan(1_000);
  }, 20_000);

  it('reads sheets that never close in under a second', async () => {
    const files = {
      'xl/workbook.xml': '<workbook><sheets>' + '<sheet '.repeat(400_000),
      'xl/_rels/workbook.xml.rels':
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>',
    };
    expect(await timed(() => extract('xlsx', files))).toBeLessThan(1_000);
  }, 20_000);

  it('reads spreadsheet cells that never close in under a second', async () => {
    const files = {
      'content.xml':
        '<office:spreadsheet><table:table table:name="T"><table:table-row>' +
        '<table:table-cell>'.repeat(400_000),
    };
    expect(await timed(() => extract('ods', files))).toBeLessThan(1_000);
  }, 20_000);

  it('reads shared strings that never close in under a second', async () => {
    const files = {
      'xl/sharedStrings.xml': '<sst>' + '<si><r>'.repeat(400_000),
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>',
    };
    expect(await timed(() => extract('xlsx', files))).toBeLessThan(1_000);
  }, 20_000);
});
