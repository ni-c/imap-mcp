import type { MessageStructureObject } from 'imapflow';
import { describe, expect, it } from 'vitest';

import {
  attachmentUri,
  checkPolicy,
  collectAttachments,
  describeExecutable,
  imageTypeOf,
  EXECUTABLE_EXTENSIONS,
  extensionOf,
  sanitizeFilename,
  sniffContent,
  type AttachmentCandidate,
} from '../src/attachments.js';
import { DEFAULT_ATTACHMENT_TYPES } from '../src/config.js';

const policy = {
  allowedTypes: DEFAULT_ATTACHMENT_TYPES,
  maxBytes: 1024,
  maxBytesName: 'IMAP_MAX_ATTACHMENT_BYTES',
};

function candidate(
  overrides: Partial<AttachmentCandidate> = {}
): AttachmentCandidate {
  return {
    partId: '2',
    filename: 'report.pdf',
    contentType: 'application/pdf',
    size: 100,
    disposition: 'attachment',
    allowed: true,
    notes: [],
    ...overrides,
  };
}

describe('sanitizeFilename', () => {
  it('keeps an ordinary name', () => {
    expect(sanitizeFilename('Invoice 2026-08.pdf')).toBe('Invoice 2026-08.pdf');
  });

  it('replaces path separators and drops the leading dots', () => {
    const cleaned = sanitizeFilename('../../etc/passwd');
    expect(cleaned).toBe('_.._etc_passwd');
    expect(cleaned).not.toMatch(/[/\\]/);
    expect(cleaned.startsWith('.')).toBe(false);
  });

  it('replaces Windows separators too', () => {
    expect(sanitizeFilename('C:\\Windows\\System32\\evil.txt')).toBe(
      'C__Windows_System32_evil.txt'
    );
  });

  it('strips a right-to-left override that disguises the extension', () => {
    // "invoice[RLO]fdp.exe" renders as "invoiceexe.pdf" in many clients.
    expect(sanitizeFilename('invoice\u202efdp.exe')).toBe('invoicefdp.exe');
  });

  it('falls back for an empty or missing name', () => {
    expect(sanitizeFilename(undefined)).toBe('(unnamed)');
    expect(sanitizeFilename('   ')).toBe('(unnamed)');
    expect(sanitizeFilename('...')).toBe('(unnamed)');
  });

  it('truncates a very long name', () => {
    expect(sanitizeFilename('a'.repeat(400)).length).toBeLessThanOrEqual(121);
  });
});

const refused = (name: string) =>
  checkPolicy(
    candidate({
      filename: sanitizeFilename(name),
      contentType: 'text/plain',
    }),
    policy
  );

describe('sanitizeFilename and the extension that will be saved', () => {
  it.each([
    'Rechnung.bat.',
    'Rechnung.bat. .',
    'Rechnung.bat . . ',
    'Rechnung.exe...',
    'Rechnung.exe\u0001',
    'Rechnung.exe\t',
  ])('refuses %j, which Windows saves as an executable', (name) => {
    // Windows drops trailing dots and spaces on open. The check has to see the
    // name the file system will, not the one the sender wrote.
    const saved = sanitizeFilename(name);
    expect(saved).not.toMatch(/[.\s]$/);
    expect(extensionOf(saved)).toMatch(/^(bat|exe)$/);
    expect(refused(name).allowed).toBe(false);
  });

  it.each([
    ['Rechnung.bat::$DATA', 'Rechnung.bat__$DATA'],
    ['Rechnung.bat:stream', 'Rechnung.bat_stream'],
  ])('does not save an alternate data stream name: %j', (name, saved) => {
    expect(sanitizeFilename(name)).toBe(saved);
  });

  it('replaces the characters Windows reads specially', () => {
    expect(sanitizeFilename('a<b>c"d|e?f*g.txt')).toBe('a_b_c_d_e_f_g.txt');
  });

  it.each([
    ['CON', '_CON'],
    ['nul', '_nul'],
    ['AUX.txt', '_AUX.txt'],
    ['PRN.pdf', '_PRN.pdf'],
    ['COM1', '_COM1'],
    ['com9.csv', '_com9.csv'],
    ['LPT1.txt', '_LPT1.txt'],
    ['CON .txt', '_CON .txt'],
    ['CON.', '_CON'],
    ['COM\u00b9.txt', '_COM1.txt'],
  ])('renames the device name %j', (name, saved) => {
    expect(sanitizeFilename(name)).toBe(saved);
  });

  it.each([
    'CONSOLE.txt',
    'COM10.txt',
    'LPT0.txt',
    'aux-notes.txt',
    'nullable',
  ])('leaves %j alone: it is not a device', (name) => {
    expect(sanitizeFilename(name)).toBe(name);
  });

  it('still refuses a device-named executable by its extension', () => {
    expect(refused('NUL.exe').allowed).toBe(false);
  });

  it('keeps the extension when the stem is cut', () => {
    const saved = sanitizeFilename(`${'a'.repeat(130)}.exe`);
    expect(saved.endsWith('.exe')).toBe(true);
    expect(saved.length).toBeLessThanOrEqual(121);
    expect(refused(`${'a'.repeat(130)}.exe`).allowed).toBe(false);
  });

  it('keeps a long extension from the blocklist whole', () => {
    const saved = sanitizeFilename(`${'b'.repeat(300)}.settingcontent-ms`);
    expect(saved.endsWith('.settingcontent-ms')).toBe(true);
    expect(refused(`${'b'.repeat(300)}.settingcontent-ms`).allowed).toBe(false);
  });

  it('caps the name by bytes, so a CJK name fits a file system', () => {
    const saved = sanitizeFilename(`${'請求書'.repeat(40)}.pdf`);
    expect(Buffer.byteLength(saved)).toBeLessThanOrEqual(200);
    expect(saved.endsWith('.pdf')).toBe(true);
    // Not cut in the middle of a character.
    expect(saved).not.toContain('\ufffd');
    expect(saved.toWellFormed()).toBe(saved);
  });

  it('does not split a surrogate pair when it cuts', () => {
    const saved = sanitizeFilename(`${'😀'.repeat(100)}.png`);
    expect(Buffer.byteLength(saved)).toBeLessThanOrEqual(200);
    expect(saved.toWellFormed()).toBe(saved);
    expect(saved.endsWith('.png')).toBe(true);
  });

  it('leaves a name that fits untouched', () => {
    const name = `${'x'.repeat(100)}.pdf`;
    expect(sanitizeFilename(name)).toBe(name);
  });

  it('cuts a long name with no extension', () => {
    const saved = sanitizeFilename('n'.repeat(500));
    expect(saved.length).toBeLessThanOrEqual(121);
  });
});

describe('the executable blocklist', () => {
  it.each([
    'library-ms',
    'search-ms',
    'settingcontent-ms',
    'msix',
    'msixbundle',
    'appx',
    'appxbundle',
    'vhd',
    'vhdx',
    'img',
    'pyw',
    'cab',
    'wsb',
    'xbap',
    'mht',
    'mhtml',
    'website',
    'diagcab',
  ])('contains .%s and can read it back out of a name', (extension) => {
    expect(EXECUTABLE_EXTENSIONS.has(extension)).toBe(true);
    expect(extensionOf(`file.${extension}`)).toBe(extension);
  });
});

describe('extensionOf', () => {
  it.each([
    ['report.pdf', 'pdf'],
    ['Archive.TAR.GZ', 'gz'],
    ['noextension', ''],
    ['trailing.', ''],
    // A hyphen and eleven characters: both were outside the old character
    // class, and an extension that reads as '' is one checkPolicy skips.
    ['launch.appref-ms', 'appref-ms'],
    ['setup.application', 'application'],
    ['x.settingcontent-ms', 'settingcontent-ms'],
  ])('reads %s as %s', (name, expected) => {
    expect(extensionOf(name)).toBe(expected);
  });
});

describe('collectAttachments', () => {
  it('returns nothing for a plain text message', () => {
    const structure: MessageStructureObject = {
      part: '1',
      type: 'text/plain',
      size: 10,
    };
    expect(collectAttachments(structure)).toEqual([]);
  });

  it('finds an attachment next to the body', () => {
    const structure: MessageStructureObject = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', size: 10 },
        {
          part: '2',
          type: 'application/pdf',
          size: 500,
          disposition: 'attachment',
          dispositionParameters: { filename: 'report.pdf' },
        },
      ],
    };
    expect(collectAttachments(structure)).toMatchObject([
      { partId: '2', filename: 'report.pdf', contentType: 'application/pdf' },
    ]);
  });

  it('descends into a forwarded message', () => {
    const structure: MessageStructureObject = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', size: 10 },
        {
          type: 'message/rfc822',
          childNodes: [
            {
              type: 'multipart/mixed',
              childNodes: [
                { part: '2.1', type: 'text/plain', size: 5 },
                {
                  part: '2.2',
                  type: 'image/png',
                  size: 20,
                  disposition: 'attachment',
                  dispositionParameters: { filename: 'inner.png' },
                },
              ],
            },
          ],
        },
      ],
    };
    expect(collectAttachments(structure).map((a) => a.partId)).toEqual(['2.2']);
  });

  it('counts an inline image as an attachment', () => {
    const structure: MessageStructureObject = {
      type: 'multipart/related',
      childNodes: [
        { part: '1', type: 'text/html', size: 10 },
        {
          part: '2',
          type: 'image/png',
          size: 20,
          disposition: 'inline',
          parameters: { name: 'tracker.png' },
        },
      ],
    };
    expect(collectAttachments(structure)).toHaveLength(1);
  });

  it('flags a double extension', () => {
    const structure: MessageStructureObject = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', size: 1 },
        {
          part: '2',
          type: 'application/pdf',
          size: 10,
          disposition: 'attachment',
          dispositionParameters: { filename: 'invoice.pdf.exe' },
        },
      ],
    };
    expect(collectAttachments(structure)[0]?.notes.join(' ')).toContain(
      'double extension'
    );
  });

  it('lists a single non-multipart message whose root is the attachment', () => {
    // No `part` on the root: imapflow leaves it off for a message that is not
    // multipart, and the walk used to drop it as "not a part".
    const structure: MessageStructureObject = {
      type: 'application/pdf',
      size: 500,
      disposition: 'attachment',
      dispositionParameters: { filename: 'scan.pdf' },
    };
    expect(collectAttachments(structure)).toMatchObject([
      { partId: '1', filename: 'scan.pdf', contentType: 'application/pdf' },
    ]);
  });

  it('still lists nothing for a single-part text body', () => {
    expect(collectAttachments({ type: 'text/plain', size: 4 })).toEqual([]);
  });

  it('lists an attached .eml itself, and what is inside it', () => {
    const structure: MessageStructureObject = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', size: 10 },
        {
          part: '2',
          type: 'message/rfc822',
          size: 900,
          disposition: 'attachment',
          dispositionParameters: { filename: 'forwarded.eml' },
          childNodes: [
            {
              type: 'multipart/mixed',
              childNodes: [
                { part: '2.1', type: 'text/plain', size: 5 },
                {
                  part: '2.2',
                  type: 'application/pdf',
                  size: 20,
                  disposition: 'attachment',
                  dispositionParameters: { filename: 'inner.pdf' },
                },
              ],
            },
          ],
        },
      ],
    };
    expect(
      collectAttachments(structure).map((a) => [a.partId, a.filename])
    ).toEqual([
      ['2', 'forwarded.eml'],
      ['2.2', 'inner.pdf'],
    ]);
  });

  it('does not list a forwarded message that carries no name as an attachment', () => {
    const structure: MessageStructureObject = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', size: 10 },
        {
          part: '2',
          type: 'message/rfc822',
          size: 900,
          childNodes: [{ part: '2.1', type: 'text/plain', size: 5 }],
        },
      ],
    };
    expect(collectAttachments(structure)).toEqual([]);
  });

  it("does not emit a child that shares its parent's part id", () => {
    // A single-part forwarded message: the child is reported under the id of
    // the wrapper, and fetching that id returns the wrapper.
    const structure: MessageStructureObject = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', size: 10 },
        {
          part: '2',
          type: 'message/rfc822',
          size: 900,
          disposition: 'attachment',
          dispositionParameters: { filename: 'one.eml' },
          childNodes: [
            {
              part: '2',
              type: 'application/pdf',
              size: 20,
              dispositionParameters: { filename: 'inside.pdf' },
            },
          ],
        },
      ],
    };
    expect(collectAttachments(structure).map((a) => a.partId)).toEqual(['2']);
    expect(collectAttachments(structure)[0]?.filename).toBe('one.eml');
  });

  it('does not take a top-level message/rfc822 root for an attachment', () => {
    const structure: MessageStructureObject = {
      type: 'message/rfc822',
      dispositionParameters: { filename: 'x.eml' },
      childNodes: [{ part: '1', type: 'text/plain', size: 5 }],
    };
    expect(collectAttachments(structure)).toEqual([]);
  });

  it('stops descending at the depth limit instead of looping', () => {
    let node: MessageStructureObject = {
      part: '9',
      type: 'application/pdf',
      size: 1,
      dispositionParameters: { filename: 'deep.pdf' },
    };
    for (let i = 0; i < 12; i += 1) {
      node = { type: 'multipart/mixed', childNodes: [node] };
    }
    expect(collectAttachments(node)).toEqual([]);
  });
});

describe('checkPolicy', () => {
  it('allows an ordinary PDF', () => {
    expect(checkPolicy(candidate(), policy).allowed).toBe(true);
  });

  it('refuses an executable extension', () => {
    const result = checkPolicy(
      candidate({ filename: 'setup.exe', contentType: 'application/pdf' }),
      policy
    );
    expect(result.allowed).toBe(false);
    expect(result.notes.join(' ')).toContain('executable file type');
  });

  it('refuses a content type outside the allowlist', () => {
    const result = checkPolicy(
      candidate({ contentType: 'application/x-sh', filename: 'x.txt' }),
      policy
    );
    expect(result.allowed).toBe(false);
    expect(result.notes.join(' ')).toContain('allowlist');
  });

  it('refuses an oversized declaration', () => {
    const result = checkPolicy(candidate({ size: 999_999 }), policy);
    expect(result.allowed).toBe(false);
    expect(result.notes.join(' ')).toContain('IMAP_MAX_ATTACHMENT_BYTES');
  });

  it('does not mutate the input', () => {
    const input = candidate({ filename: 'setup.exe' });
    checkPolicy(input, policy);
    expect(input.allowed).toBe(true);
    expect(input.notes).toEqual([]);
  });

  it.each([...EXECUTABLE_EXTENSIONS])(
    'refuses .%s, so the whole blocklist stays reachable',
    (extension) => {
      // The list and the extractor are two declarations that have to agree, and
      // reading them side by side does not show when they stop agreeing:
      // 'appref-ms' and 'application' sat in the list for months while
      // extensionOf returned '' for both, which makes checkPolicy skip the
      // executable check rather than fail it. Declared as a type from the
      // allowlist, either one was allowed with no note against it.
      const result = checkPolicy(
        // A content type that passes on its own, so the extension is what the
        // assertion is about.
        candidate({
          filename: `invoice.${extension}`,
          contentType: 'application/pdf',
        }),
        policy
      );
      expect(result.allowed).toBe(false);
      expect(result.notes.join(' ')).toContain(
        `refused: .${extension} is an executable file type`
      );
    }
  );
});

function pe(): Buffer {
  const buffer = Buffer.alloc(0x100);
  buffer.write('MZ', 0, 'latin1');
  buffer.writeUInt32LE(0x80, 0x3c);
  buffer.write('PE\0\0', 0x80, 'latin1');
  return buffer;
}

describe('sniffContent', () => {
  it.each([
    ['MZ', Buffer.from([0x4d, 0x5a, 0x90, 0x00]), 'application/x-msdownload'],
    ['ELF', Buffer.from([0x7f, 0x45, 0x4c, 0x46]), 'application/x-elf'],
    ['shebang', Buffer.from('#!/bin/sh\n'), 'text/x-shellscript'],
  ])('detects %s as executable', (_name, buffer, type) => {
    expect(sniffContent(buffer)).toEqual({
      executable: true,
      detectedType: type,
    });
  });

  it.each([
    ['Mach-O 32', 0xfeedface],
    ['Mach-O 64', 0xfeedfacf],
    ['fat binary', 0xcafebabe],
  ])('detects %s as executable', (_name, magic) => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(magic >>> 0, 0);
    expect(sniffContent(buffer).executable).toBe(true);
  });

  it.each([
    ['Mach-O 32, little-endian', [0xce, 0xfa, 0xed, 0xfe]],
    ['Mach-O 64, little-endian', [0xcf, 0xfa, 0xed, 0xfe]],
  ])('detects %s as executable', (_name, bytes) => {
    expect(sniffContent(Buffer.from([...bytes, 7, 0, 0, 1]))).toEqual({
      executable: true,
      detectedType: 'application/x-mach-binary',
    });
  });

  describe('MZ', () => {
    it('refuses a portable executable', () => {
      expect(sniffContent(pe())).toEqual({
        executable: true,
        detectedType: 'application/x-msdownload',
      });
    });

    it('refuses an older new-format executable', () => {
      const buffer = pe();
      buffer.write('NE', 0x80, 'latin1');
      expect(sniffContent(buffer).executable).toBe(true);
    });

    it('refuses a DOS executable, which has no PE header but is not text', () => {
      const dos = Buffer.alloc(64);
      dos.write('MZ', 0, 'latin1');
      dos.writeUInt16LE(0x20, 2);
      expect(sniffContent(dos).executable).toBe(true);
    });

    it('does not refuse text that merely starts with MZ', () => {
      expect(
        sniffContent(Buffer.from('MZ,Mozambique\nMW,Malawi\n')).executable
      ).toBe(false);
      expect(sniffContent(Buffer.from('MZ')).executable).toBe(false);
      expect(sniffContent(Buffer.from('MZ\r\n\tkept\n')).executable).toBe(
        false
      );
    });

    it('does not follow an e_lfanew that points outside the buffer', () => {
      const buffer = Buffer.from('MZ'.padEnd(0x40, 'x'), 'latin1');
      buffer.writeUInt32LE(0xffffffff, 0x3c);
      expect(() => sniffContent(buffer)).not.toThrow();
    });
  });

  it('says why a #! script is refused even when declared as text', () => {
    const verdict = sniffContent(Buffer.from('#!/bin/sh\nrm -rf ~\n'));
    expect(verdict.executable).toBe(true);
    expect(describeExecutable(verdict)).toContain('#!');
    expect(describeExecutable(verdict)).toContain('declared as text');
    expect(
      describeExecutable({
        executable: true,
        detectedType: 'application/x-elf',
      })
    ).toBe('an executable (application/x-elf)');
  });

  it.each([
    ['PDF', Buffer.from('%PDF-1.7\n'), 'application/pdf'],
    ['PNG', Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png'],
    ['JPEG', Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg'],
    ['GIF', Buffer.from('GIF89a'), 'image/gif'],
    ['ZIP', Buffer.from([0x50, 0x4b, 0x03, 0x04]), 'application/zip'],
  ])('detects %s', (_name, buffer, type) => {
    expect(sniffContent(buffer)).toEqual({
      executable: false,
      detectedType: type,
    });
  });

  it('detects WEBP through the RIFF container', () => {
    const buffer = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('WEBP'),
    ]);
    expect(sniffContent(buffer).detectedType).toBe('image/webp');
  });

  it('reports nothing for plain text', () => {
    expect(sniffContent(Buffer.from('Hello.'))).toEqual({
      executable: false,
      detectedType: undefined,
    });
  });

  it('does not read past the end of a short buffer', () => {
    expect(() => sniffContent(Buffer.alloc(0))).not.toThrow();
    expect(sniffContent(Buffer.from([0x4d]))).toEqual({
      executable: false,
      detectedType: undefined,
    });
  });
});

describe('imageTypeOf', () => {
  const allowed = ['image/png', 'image/jpeg'];

  it('answers with the type of the bytes', () => {
    expect(
      imageTypeOf({ executable: false, detectedType: 'image/jpeg' }, allowed)
    ).toBe('image/jpeg');
  });

  it.each([
    ['not an image', 'application/pdf'],
    ['an image the operator did not allow', 'image/gif'],
    ['unrecognised', undefined],
  ])('answers nothing for bytes that are %s', (_what, detectedType) => {
    expect(imageTypeOf({ executable: false, detectedType }, allowed)).toBe(
      undefined
    );
  });
});

describe('attachmentUri', () => {
  it('leaves the default mailbox out', () => {
    expect(attachmentUri(7, '2.1', 'INBOX', 'INBOX')).toBe(
      'imap://message/7/part/2.1'
    );
  });

  it('carries any other mailbox, encoded', () => {
    expect(attachmentUri(7, '2', 'INBOX/Rechnungen 2026', 'INBOX')).toBe(
      'imap://message/7/part/2?mailbox=INBOX%2FRechnungen%202026'
    );
  });
});
