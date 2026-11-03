import type { ImapFlow, SearchObject } from 'imapflow';
import compile from 'imapflow/lib/handler/imap-compiler.js';
import { searchCompiler } from 'imapflow/lib/search-compiler.js';
import { describe, expect, it } from 'vitest';

/**
 * What `gmail_query` puts on the wire.
 *
 * The tool tests stop at the ImapFlow boundary: they assert the SearchObject
 * handed to `search()`, with `search()` itself replaced. Whether that object
 * becomes one X-GM-RAW key with one argument — quoted, escaped, or sent as a
 * byte-counted literal — is decided inside imapflow, and an imapflow update
 * could change it without any tool test noticing. These run the library's own
 * search and command compilers, against a connection that is only the two sets
 * the search compiler reads.
 */
function server(capabilities: string[], enabled: string[] = []): ImapFlow {
  return {
    capabilities: new Map(capabilities.map((name) => [name, true])),
    enabled: new Set(enabled),
  } as unknown as ImapFlow;
}

const GMAIL = server(['IMAP4rev1', 'X-GM-EXT-1']);

type Attributes = Parameters<typeof compile>[0]['attributes'];

/** The command as the server receives it, one string per literal segment. */
function wire(query: SearchObject, connection = GMAIL): string[] {
  const attributes = searchCompiler(connection, query) as Attributes;
  return compile(
    { tag: 'A1', command: 'UID SEARCH', attributes },
    { asArray: true }
  ).map((part) => part.toString('utf8'));
}

describe('gmail_query on the wire', () => {
  it('sends a query of several words as one quoted X-GM-RAW argument', () => {
    expect(wire({ gmraw: 'has:attachment filename:pdf' })).toEqual([
      'A1 UID SEARCH X-GM-RAW "has:attachment filename:pdf"',
    ]);
  });

  it('escapes quotes and backslashes rather than ending the string', () => {
    expect(wire({ gmraw: 'subject:"Q3 report" a\\b' })).toEqual([
      'A1 UID SEARCH X-GM-RAW "subject:\\"Q3 report\\" a\\\\b"',
    ]);
  });

  it('sends a single token as an atom, followed by the other filters', () => {
    // Every character of `filename:pdf` is an ATOM-CHAR, so it goes unquoted;
    // the standard filters follow as keys of their own, which IMAP ANDs.
    expect(wire({ gmraw: 'filename:pdf', seen: false })).toEqual([
      'A1 UID SEARCH X-GM-RAW filename:pdf UNSEEN',
    ]);
  });

  it('sends a non-ASCII query as a literal under CHARSET UTF-8', () => {
    const query = 'subject:März';
    expect(wire({ gmraw: query })).toEqual([
      `A1 UID SEARCH CHARSET UTF-8 X-GM-RAW {${Buffer.byteLength(query)}}\r\n`,
      query,
    ]);
  });

  it('leaves CHARSET out once UTF8=ACCEPT is enabled', () => {
    const query = 'subject:März';
    expect(
      wire({ gmraw: query }, server(['X-GM-EXT-1'], ['UTF8=ACCEPT']))
    ).toEqual([
      `A1 UID SEARCH X-GM-RAW {${Buffer.byteLength(query)}}\r\n`,
      query,
    ]);
  });

  it('counts a line break inside a literal as data, not as the end of the command', () => {
    // The schema refuses CR and LF before this point. Behind it, a non-ASCII
    // value is a literal whose length covers the break, so the server reads
    // `A2 LOGOUT` as part of the query.
    const query = 'März\r\nA2 LOGOUT';
    expect(wire({ gmraw: query })).toEqual([
      `A1 UID SEARCH CHARSET UTF-8 X-GM-RAW {${Buffer.byteLength(query)}}\r\n`,
      query,
    ]);
  });

  it.each(['x\r\nA2 LOGOUT', 'x\ny', 'x\0y'])(
    'refuses %j as a quoted string rather than writing it',
    (query) => {
      expect(() => wire({ gmraw: query })).toThrow(
        expect.objectContaining({ code: 'InvalidStringValue' })
      );
    }
  );

  it('refuses the key on a server without X-GM-EXT-1 instead of dropping it', () => {
    // Dropping it would turn `{ gmraw }` into a search for every message.
    expect(() => wire({ gmraw: 'x' }, server(['IMAP4rev1']))).toThrow(
      expect.objectContaining({ code: 'MissingServerExtension' })
    );
  });

  it('refuses a key it does not know, so a renamed one cannot widen the search', () => {
    expect(() => wire({ gmrow: 'x' } as unknown as SearchObject)).toThrow(
      expect.objectContaining({ code: 'InvalidSearchQuery' })
    );
  });
});
