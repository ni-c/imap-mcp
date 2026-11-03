import { randomUUID } from 'node:crypto';

import { ToolInputError } from './errors.js';
import { addressParam } from './schema.js';

/** Headers linking a draft into an existing conversation. */
export interface ThreadHeaders {
  messageId: string | undefined;
  references: string[];
}

export interface DraftInput {
  from: string | undefined;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  thread?: ThreadHeaders;
  /** Injected by the tests; real calls stamp the current time. */
  date?: Date;
}

/** Encoded-words must not exceed 75 characters including the delimiters. */
const ENCODED_WORD_PAYLOAD = 45;

/**
 * Builds an RFC 5322 message for `APPEND`.
 *
 * Written by hand rather than pulled from a library because the only consumer
 * is this one path, and because every field here needs the same treatment: a
 * bare CR or LF in a header value would let the caller append headers of its
 * own — a Bcc, a Reply-To pointing elsewhere — to a message a human will later
 * send under their own name. The schemas reject line breaks already; this is
 * the second lock on the same door.
 */
/** Whether the login can stand as a From address. */
export function fromIsAddress(from: string): boolean {
  return addressParam.safeParse(from).success;
}

export function buildDraft(input: DraftInput): Buffer {
  const from = input.from;
  if (from === undefined || from === '') {
    throw new ToolInputError(
      'imap-mcp: no sender address available — IMAP_USER is not set.'
    );
  }

  // The sender is the IMAP login, and a login is not always an address:
  // `alice` and `DOMAIN\\alice` are accounts. Such a login is left out rather
  // than written as an unusable From header; the mail client fills in the
  // identity when the draft is sent.
  const headers: Array<[string, string]> = [
    ...(fromIsAddress(from) ? [['From', from] as [string, string]] : []),
    ['To', foldAddresses('To', input.to)],
  ];
  if (input.cc !== undefined && input.cc.length > 0) {
    headers.push(['Cc', foldAddresses('Cc', input.cc)]);
  }
  if (input.bcc !== undefined && input.bcc.length > 0) {
    headers.push(['Bcc', foldAddresses('Bcc', input.bcc)]);
  }
  headers.push(['Subject', encodeHeaderValue(input.subject)]);
  headers.push(['Date', (input.date ?? new Date()).toUTCString()]);
  headers.push(['Message-ID', `<${randomUUID()}@imap-mcp.invalid>`]);

  if (input.thread?.messageId !== undefined) {
    headers.push(['In-Reply-To', input.thread.messageId]);
  }
  if (input.thread !== undefined && input.thread.references.length > 0) {
    headers.push(['References', foldReferences(input.thread.references)]);
  }

  headers.push(['MIME-Version', '1.0']);
  headers.push(['Content-Type', 'text/plain; charset=utf-8']);
  headers.push(['Content-Transfer-Encoding', 'base64']);

  const lines = headers.map(([name, value]) => {
    assertHeaderSafe(name, value);
    return `${name}: ${value}`;
  });

  // base64 for the body: it survives any charset, cannot contain a line that
  // looks like a header, and keeps lines inside the 998-octet limit. Line
  // breaks are made CRLF first: text/plain on the wire is CRLF text, and a
  // client decoding the part would otherwise show bare LFs as it received them.
  const text = input.body.replace(/\r\n|\r|\n/g, '\r\n');
  const encoded = (
    Buffer.from(text, 'utf-8')
      .toString('base64')
      .match(/.{1,76}/g) ?? []
  ).join('\r\n');

  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n${encoded}\r\n`, 'utf-8');
}

/** Keep every folded header line under the RFC 5322 hard limit of 998 octets. */
const MAX_HEADER_LINE = 900;

/**
 * Joins the References chain, folding onto continuation lines as needed.
 *
 * Twenty Message-IDs of up to 257 characters each on a single line would pass
 * 5 kB — five times the 998-octet line limit, which some servers answer by
 * refusing the APPEND and others by mangling the header. Folding (CRLF
 * followed by a space) is how RFC 5322 says a long header is written.
 */
function foldReferences(references: string[]): string {
  const lines: string[] = [];
  let line = '';
  for (const reference of references) {
    if (line === '') {
      line = reference;
    } else if (line.length + 1 + reference.length > MAX_HEADER_LINE) {
      lines.push(line);
      line = reference;
    } else {
      line = `${line} ${reference}`;
    }
  }
  if (line !== '') lines.push(line);
  return lines.join('\r\n ');
}

/**
 * Joins an address list, folding after a comma when a line would pass the
 * limit.
 *
 * Fifty addresses of 254 characters are 13 kB on one line, which servers
 * answer by refusing the APPEND or by cutting the header off. A fold between
 * two addresses is invisible to every parser; one inside an address would not
 * be, and an address is never split.
 */
function foldAddresses(name: string, addresses: string[]): string {
  const lines: string[] = [];
  let line = '';
  // The first line also carries "Name: ".
  let used = name.length + 2;
  for (const address of addresses) {
    if (line === '') {
      line = address;
    } else if (used + line.length + 2 + address.length > MAX_HEADER_LINE) {
      lines.push(`${line},`);
      line = address;
      used = 1;
    } else {
      line = `${line}, ${address}`;
    }
  }
  if (line !== '') lines.push(line);
  return lines.join('\r\n ');
}

/**
 * A CRLF is only legal in a header when the next line starts with whitespace —
 * that is folding. Anything else ends the header and starts a new one, which is
 * exactly the injection this guards against.
 */
function assertHeaderSafe(name: string, value: string): void {
  if (/\r(?!\n)|(?<!\r)\n|\r\n(?![ \t])/.test(value)) {
    throw new ToolInputError(
      `imap-mcp: the ${name} header must not contain line breaks.`
    );
  }
}

/**
 * Encodes a header value as MIME encoded-words when it is not plain ASCII.
 *
 * A raw UTF-8 subject is rejected or mangled by a fair number of servers, and
 * the draft has to survive being opened in whatever mail client the person uses.
 */
export function encodeHeaderValue(value: string): string {
  if (!/[^ -~]/.test(value)) return value;

  const words: string[] = [];
  let chunk = '';
  for (const character of value) {
    const candidate = chunk + character;
    if (Buffer.byteLength(candidate, 'utf-8') > ENCODED_WORD_PAYLOAD) {
      words.push(chunk);
      chunk = character;
    } else {
      chunk = candidate;
    }
  }
  if (chunk !== '') words.push(chunk);

  return words
    .map(
      (word) => `=?UTF-8?B?${Buffer.from(word, 'utf-8').toString('base64')}?=`
    )
    .join('\r\n ');
}
