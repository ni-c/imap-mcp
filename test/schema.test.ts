import fc from 'fast-check';
import { simpleParser } from 'mailparser';
import { describe, expect, it } from 'vitest';

import {
  addressListParam,
  addressParam,
  confirmTokenParam,
  dateParam,
  flagListParam,
  flagParam,
  limitParam,
  mailboxParam,
  searchTextParam,
  uidListParam,
  uidParam,
  MAX_LIMIT,
} from '../src/schema.js';

describe('mailboxParam', () => {
  it.each(['INBOX', 'INBOX/Archive', 'INBOX.Sent', 'Gelöschte Elemente'])(
    'accepts %s',
    (value) => {
      expect(mailboxParam.safeParse(value).success).toBe(true);
    }
  );

  it.each([
    ['a line break', 'INBOX\r\nLOGOUT'],
    ['a bare newline', 'INBOX\nX'],
    ['a NUL', 'INBOX\u0000'],
    ['the % wildcard', 'INBOX/%'],
    ['the * wildcard', '*'],
    ['an empty name', ''],
    // The CR/LF/NUL check let the rest of the C0/C1 range through. A bare CR
    // is the one that matters most: the confirmation a person reads before
    // losing messages is line-oriented, and a CR-padded name overwrites it.
    ['a bare carriage return', 'INBOX\rArchive'],
    ['a bell character', 'INBOX'],
    ['an escape character', 'INBOX[2J'],
    ['a DEL', 'INBOX'],
    ['a C1 control', 'INBOX'],
  ])('refuses %s', (_name, value) => {
    expect(mailboxParam.safeParse(value).success).toBe(false);
  });

  it('still accepts a folder that someone else named badly', () => {
    // Not the same call. A zero-width space in a folder name is a problem to
    // show, not one to refuse: the folder exists, and a parameter that rejected
    // its name would leave it unreadable and undeletable through this server.
    expect(mailboxParam.safeParse('Archive\u200b').success).toBe(true);
  });

  it('refuses an absurdly long name', () => {
    expect(mailboxParam.safeParse('a'.repeat(256)).success).toBe(false);
  });
});

describe('uidParam', () => {
  it.each([1, 4294967295])('accepts %s', (value) => {
    expect(uidParam.safeParse(value).success).toBe(true);
  });

  it.each([0, -1, 1.5, '3'])('refuses %s', (value) => {
    expect(uidParam.safeParse(value).success).toBe(false);
  });

  it.each([4294967296, Number.MAX_SAFE_INTEGER])(
    'refuses %s, which is past the largest IMAP UID',
    (value) => {
      expect(uidParam.safeParse(value).success).toBe(false);
    }
  );
});

describe('uidListParam', () => {
  it('accepts a list', () => {
    expect(uidListParam.safeParse([1, 2, 3]).success).toBe(true);
  });

  it('refuses an empty list', () => {
    expect(uidListParam.safeParse([]).success).toBe(false);
  });

  it('holds every UID to the nz-number range', () => {
    expect(uidListParam.safeParse([1, 4294967295]).success).toBe(true);
    expect(uidListParam.safeParse([1, 4294967296]).success).toBe(false);
    expect(uidListParam.safeParse([Number.MAX_SAFE_INTEGER]).success).toBe(
      false
    );
  });

  it('refuses more than the cap', () => {
    expect(
      uidListParam.safeParse(
        Array.from({ length: MAX_LIMIT + 1 }, (_u, i) => i + 1)
      ).success
    ).toBe(false);
  });
});

describe('limitParam', () => {
  it('accepts a value inside the cap and rejects above it', () => {
    expect(limitParam.safeParse(MAX_LIMIT).success).toBe(true);
    expect(limitParam.safeParse(MAX_LIMIT + 1).success).toBe(false);
    expect(limitParam.safeParse(0).success).toBe(false);
    expect(limitParam.safeParse(undefined).success).toBe(true);
  });
});

describe('dateParam', () => {
  it.each(['2026-08-24', '2024-02-29'])('accepts %s', (value) => {
    expect(dateParam.safeParse(value).success).toBe(true);
  });

  it('refuses a date that does not exist', () => {
    // V8 rolls 2026-02-30 over into March instead of rejecting it, so the
    // schema has to round-trip rather than trust the Date constructor.
    expect(dateParam.safeParse('2026-02-30').success).toBe(false);
    expect(dateParam.safeParse('2023-02-29').success).toBe(false);
  });

  it.each(['24.08.2026', '2026-8-4', 'yesterday', '2026-08-24T10:00:00Z'])(
    'refuses %s',
    (value) => {
      expect(dateParam.safeParse(value).success).toBe(false);
    }
  );
});

describe('addressParam', () => {
  it.each([
    'person@example.net',
    'first.last+tag@sub.example.net',
    "o'brien@example.net",
    'a_b-c=d@example.co.uk',
    'user@xn--bcher-kva.example',
  ])('accepts %s', (value) => {
    expect(addressParam.safeParse(value).success).toBe(true);
  });

  it('refuses a header injection attempt', () => {
    // The attack: an address that appends a Bcc to a message a human approved.
    expect(
      addressParam.safeParse('person@example.net\r\nBcc: attacker@example.org')
        .success
    ).toBe(false);
  });

  it.each([
    'not-an-address',
    'no@domain',
    'two@@example.net',
    'spaces in@example.net',
    '"Name" <person@example.net>',
  ])('refuses %s', (value) => {
    expect(addressParam.safeParse(value).success).toBe(false);
  });

  it.each([
    // A mail client shows one recipient and the draft goes to another.
    [
      'a display name run into an angle address',
      'AliceSmith<alice@evil.example>',
    ],
    ['a comment after the domain', 'x@evil.example(Alice)'],
    ['a group', 'team:x@evil.example;'],
    ['a second address behind a comma', 'ceo,x@evil.example'],
    ['a second address behind a semicolon', 'ceo;x@evil.example'],
    ['a quoted local part', '"a b"@evil.example'],
    ['a domain literal', 'x@[192.0.2.1]'],
    ['a leading dot', '.x@evil.example'],
    ['a doubled dot', 'x..y@evil.example'],
    ['a trailing dot in the domain', 'x@evil.example.'],
    ['a label starting with a hyphen', 'x@-evil.example'],
    ['a backslash', 'x\\y@evil.example'],
  ])('refuses %s', (_why, value) => {
    expect(addressParam.safeParse(value).success).toBe(false);
  });

  it.each([
    ['a zero-width space', 'ali\u200bce@example.net'],
    ['a bidi override', 'alice@exam\u202eple.net'],
    ['a non-ASCII local part', 'ünal@example.net'],
    ['a non-ASCII domain', 'alice@bücher.example'],
  ])('refuses %s and asks for ASCII', (_why, value) => {
    const result = addressParam.safeParse(value);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('punycode');
  });

  it('refuses a host without a dot, on purpose', () => {
    // user@localhost is a valid addr-spec and not an address anyone drafts to
    // from a mailbox; the rule is documented here so loosening it is a choice.
    expect(addressParam.safeParse('user@localhost').success).toBe(false);
  });

  it('refuses a local part or an address past the length limits', () => {
    expect(
      addressParam.safeParse(`${'a'.repeat(65)}@example.net`).success
    ).toBe(false);
    expect(addressParam.safeParse(`a@${'b'.repeat(64)}.example`).success).toBe(
      false
    );
    expect(addressParam.safeParse(`a@${'b.'.repeat(130)}example`).success).toBe(
      false
    );
  });

  it('only accepts what a mail parser reads back as exactly that one address', async () => {
    // Whatever passes the schema is written into a To/Cc/Bcc header, so the
    // property that matters is the parser's: one mailbox, the same address, no
    // display name conjured out of the rest of the string.
    const localAlphabet = [
      ...('abcXYZ019.-_+\'!#$%&*/=?^`{|}~<>()[],;:"\\ ' as string),
    ];
    const domainAlphabet = [...'abcXYZ019.-_'];
    let accepted = 0;
    await fc.assert(
      fc.asyncProperty(
        fc
          .tuple(
            fc.string({
              unit: fc.constantFrom(...localAlphabet),
              minLength: 1,
              maxLength: 12,
            }),
            fc.string({
              unit: fc.constantFrom(...domainAlphabet),
              minLength: 1,
              maxLength: 12,
            }),
            fc.string({
              unit: fc.constantFrom(...domainAlphabet),
              minLength: 1,
              maxLength: 5,
            })
          )
          .map(([local, domain, tld]) => `${local}@${domain}.${tld}`),
        async (candidate) => {
          if (!addressParam.safeParse(candidate).success) return;
          accepted += 1;
          const parsed = await simpleParser(
            `To: ${candidate}\r\nSubject: x\r\n\r\nbody`
          );
          const to = parsed.to;
          const values = Array.isArray(to)
            ? to.flatMap((group) => group.value)
            : (to?.value ?? []);
          expect(values).toEqual([{ address: candidate, name: '' }]);
        }
      ),
      { numRuns: 20_000 }
    );
    // A generator that never gets past the schema proves nothing.
    expect(accepted).toBeGreaterThan(300);
  });

  it('caps the list length', () => {
    expect(
      addressListParam.safeParse(
        Array.from({ length: 51 }, (_u, i) => `p${i}@example.net`)
      ).success
    ).toBe(false);
  });
});

describe('confirmTokenParam', () => {
  it('is optional', () => {
    expect(confirmTokenParam.safeParse(undefined).success).toBe(true);
  });

  it('accepts the token mcp-approval issues: 16 random bytes as hex', () => {
    expect(
      confirmTokenParam.safeParse('0123456789abcdef'.repeat(2)).success
    ).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['not hex', 'not-a-token'],
    ['upper case, which is never issued', 'ABCDEF0123'],
    ['with whitespace', 'abc def'],
    ['over the cap', 'a'.repeat(129)],
  ])('refuses a token that is %s', (_why, value) => {
    expect(confirmTokenParam.safeParse(value).success).toBe(false);
  });
});

describe('flagParam', () => {
  it.each(['\\Seen', '\\Flagged', 'AiSeen', '$Forwarded'])(
    'accepts %s',
    (value) => {
      expect(flagParam.safeParse(value).success).toBe(true);
    }
  );

  it.each(['\\Seen)', 'two words', 'with"quote', '\\\\double', ''])(
    'refuses %s',
    (value) => {
      expect(flagParam.safeParse(value).success).toBe(false);
    }
  );

  it('caps how many flags one call may set', () => {
    expect(
      flagListParam.safeParse(Array.from({ length: 21 }, (_u, i) => `K${i}`))
        .success
    ).toBe(false);
  });
});

describe('searchTextParam', () => {
  it('accepts an ordinary term', () => {
    expect(searchTextParam.safeParse('invoice').success).toBe(true);
  });

  it('refuses a line break and an over-long term', () => {
    expect(searchTextParam.safeParse('a\r\nb').success).toBe(false);
    expect(searchTextParam.safeParse('x'.repeat(257)).success).toBe(false);
  });
});
