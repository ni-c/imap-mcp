import { describe, expect, it } from 'vitest';

import { renderMessage, threadIdsOf } from '../src/message.js';

function mail(headers: string[], body: string): Buffer {
  return Buffer.from([...headers, '', body].join('\r\n'));
}

const BASE = ['From: a@example.net', 'To: b@example.net', 'Subject: hi'];

describe('renderMessage body', () => {
  it('does not let mailparser turn hidden HTML into the text body', async () => {
    const rendered = await renderMessage(
      1,
      mail(
        [...BASE, 'Content-Type: text/html; charset=utf-8'],
        '<p>Visible</p><div style="display:none">SECRET-HIDDEN-PROMPT</div>'
      )
    );
    expect(rendered.content).toContain('Visible');
    expect(rendered.content).not.toContain('SECRET-HIDDEN-PROMPT');
  });

  it('still prefers a real text/plain part over the HTML one', async () => {
    const rendered = await renderMessage(
      1,
      mail(
        [...BASE, 'Content-Type: multipart/alternative; boundary="b"'],
        [
          '--b',
          'Content-Type: text/plain; charset=utf-8',
          '',
          'PLAIN-PART',
          '--b',
          'Content-Type: text/html; charset=utf-8',
          '',
          '<p>HTML-PART</p>',
          '--b--',
        ].join('\r\n')
      )
    );
    expect(rendered.content).toContain('PLAIN-PART');
    expect(rendered.content).not.toContain('HTML-PART');
  });
});

const dateOf = async (value: string | undefined) =>
  (
    await renderMessage(
      1,
      mail(value === undefined ? BASE : [...BASE, `Date: ${value}`], 'x')
    )
  ).metadata.date;

describe('renderMessage date', () => {
  it('reports a valid Date header', async () => {
    expect(await dateOf('Tue, 03 Nov 2026 10:00:00 +0100')).toBe(
      '2026-11-03T09:00:00.000Z'
    );
  });

  it('omits an unparseable Date instead of reporting now', async () => {
    expect(await dateOf('not a date at all')).toBeUndefined();
  });

  it('omits a date that does not exist instead of rolling it over', async () => {
    expect(await dateOf('Tue, 31 Feb 2026 10:00:00 +0000')).toBeUndefined();
    expect(await dateOf('Tue, 03 Nov 2026 25:00:00 +0000')).toBeUndefined();
  });

  it('omits the date when there is no Date header', async () => {
    expect(await dateOf(undefined)).toBeUndefined();
  });
});

const idOf = async (value: string) =>
  (await renderMessage(1, mail([...BASE, `Message-ID: ${value}`], 'x')))
    .metadata.messageId;

describe('renderMessage message-id', () => {
  it('passes a valid id through unchanged, at the 257-character maximum', async () => {
    const id = `<${'a'.repeat(250)}@x.test>`.slice(0, 257 - 1) + '>';
    expect(id).toHaveLength(257);
    expect(await idOf(id)).toBe(id);
  });

  it('omits an id that is not a Message-ID', async () => {
    expect(await idOf('<a b@x.test>')).toBeUndefined();
  });
});

describe('threadIdsOf', () => {
  it('splits an In-Reply-To that carries several ids', () => {
    expect(threadIdsOf({ inReplyTo: '<p1@x.test> <p2@x.test>' })).toEqual([
      '<p1@x.test>',
      '<p2@x.test>',
    ]);
  });

  it('returns nothing for empty input', () => {
    expect(threadIdsOf({})).toEqual([]);
    expect(threadIdsOf({ references: [], inReplyTo: '' })).toEqual([]);
  });

  it('keeps the newest fifty references, not the oldest', () => {
    const references = Array.from({ length: 80 }, (_, i) => `<r${i}@x.test>`);
    const ids = threadIdsOf({ references, inReplyTo: '<r79@x.test>' });
    expect(ids).toHaveLength(50);
    expect(ids[0]).toBe('<r30@x.test>');
    expect(ids.at(-1)).toBe('<r79@x.test>');
  });
});
