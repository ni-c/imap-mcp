import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { saveAttachment } from '../src/download.js';
import { ToolInputError } from '../src/errors.js';

import { call, connect, jsonOf, testConfig, textOf } from './harness.js';
import { message } from './fake-imap.js';

// Lets a test make the write itself misbehave. The real `open` is used for
// everything else, so the rest of the file runs against a real file system.
const faults = vi.hoisted(() => ({
  mode: 'none' as 'none' | 'short' | 'fail',
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (faults.mode === 'none') return handle;
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'write' && faults.mode === 'short') {
            // One byte at a time, reporting the truth: a short write.
            return async (data: Buffer) => target.write(data.subarray(0, 1));
          }
          if (key === 'writeFile' && faults.mode === 'fail') {
            return async () => {
              await target.write(Buffer.from('par'));
              throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
            };
          }
          const value = Reflect.get(target, key) as unknown;
          return typeof value === 'function'
            ? (value as (...a: unknown[]) => unknown).bind(target)
            : value;
        },
      });
    },
  };
});

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'imap-mcp-test-'));
});

afterEach(async () => {
  faults.mode = 'none';
  await rm(directory, { recursive: true, force: true });
});

describe('saveAttachment', () => {
  it('writes the file and reports the path', async () => {
    const saved = await saveAttachment(
      directory,
      'report.pdf',
      Buffer.from('%PDF-1.7')
    );
    expect(saved.path).toBe(join(directory, 'report.pdf'));
    expect(saved.bytes).toBe(8);
    expect(await readFile(saved.path, 'utf-8')).toBe('%PDF-1.7');
  });

  it('creates the file readable only by its owner', async () => {
    const saved = await saveAttachment(directory, 'a.pdf', Buffer.from('x'));
    // The content is untrusted and possibly confidential at the same time.
    expect((await stat(saved.path)).mode & 0o777).toBe(0o600);
  });

  it('never overwrites an existing file', async () => {
    await writeFile(join(directory, 'report.pdf'), 'original');
    const saved = await saveAttachment(
      directory,
      'report.pdf',
      Buffer.from('new')
    );
    expect(saved.path).toBe(join(directory, 'report (2).pdf'));
    expect(await readFile(join(directory, 'report.pdf'), 'utf-8')).toBe(
      'original'
    );
  });

  it('keeps counting past a second collision', async () => {
    await writeFile(join(directory, 'a.txt'), '1');
    await writeFile(join(directory, 'a (2).txt'), '2');
    const saved = await saveAttachment(directory, 'a.txt', Buffer.from('3'));
    expect(saved.path).toBe(join(directory, 'a (3).txt'));
  });

  it('gives up after fifty names rather than counting forever', async () => {
    // Fifty files with this name already exist. The fifty-first is not an
    // attachment worth a fifty-second stat call: the directory is full of
    // this name, and the caller should hear that instead of waiting.
    await writeFile(join(directory, 'a.txt'), '1');
    for (let n = 2; n <= 50; n += 1) {
      await writeFile(join(directory, `a (${n}).txt`), String(n));
    }
    await expect(
      saveAttachment(directory, 'a.txt', Buffer.from('x'))
    ).rejects.toThrow('50 files with this name');
  });

  it('explains a directory it may not write to', async () => {
    // Root writes anywhere; the case cannot be produced under it.
    if (process.getuid?.() === 0) return;
    await chmod(directory, 0o500);
    try {
      await expect(
        saveAttachment(directory, 'a.txt', Buffer.from('x'))
      ).rejects.toThrow('permission denied');
    } finally {
      await chmod(directory, 0o700);
    }
  });

  it('handles a name with no extension', async () => {
    await writeFile(join(directory, 'notes'), '1');
    const saved = await saveAttachment(directory, 'notes', Buffer.from('2'));
    expect(saved.path).toBe(join(directory, 'notes (2)'));
  });

  it('does not follow a symlink planted under the attachment name', async () => {
    // The attack: guess what the attachment will be called, point that name at
    // something valuable, and let the server write through it. `wx` refuses to
    // open an existing path at all, so the write lands beside it instead.
    const outside = join(directory, 'outside.txt');
    await writeFile(outside, 'precious');
    await symlink(outside, join(directory, 'report.pdf'));

    const saved = await saveAttachment(
      directory,
      'report.pdf',
      Buffer.from('attacker content')
    );
    expect(saved.path).toBe(join(directory, 'report (2).pdf'));
    expect(await readFile(outside, 'utf-8')).toBe('precious');
  });

  it('refuses a name that would escape the directory', async () => {
    // sanitizeFilename removes the separators long before this point; the guard
    // is here so that the write is not where a regression gets discovered.
    await expect(
      saveAttachment(directory, '../escaped.txt', Buffer.from('x'))
    ).rejects.toBeInstanceOf(ToolInputError);
  });

  it('writes everything even when the file system takes it a byte at a time', async () => {
    faults.mode = 'short';
    const content = Buffer.from('0123456789abcdef');
    const saved = await saveAttachment(directory, 'slow.bin', content);
    faults.mode = 'none';
    expect(saved.bytes).toBe(content.length);
    expect(await readFile(saved.path)).toEqual(content);
  });

  it('removes the partial file and maps the error when the write fails', async () => {
    faults.mode = 'fail';
    const error = await saveAttachment(
      directory,
      'full.pdf',
      Buffer.from('%PDF-1.7 body')
    ).catch((caught: unknown) => caught);
    faults.mode = 'none';
    expect(error).toBeInstanceOf(ToolInputError);
    expect((error as Error).message).toContain('no space left');
    expect(await readdir(directory)).toEqual([]);
  });

  it('explains a missing directory instead of leaking the errno', async () => {
    const error = await saveAttachment(
      join(directory, 'nope'),
      'a.txt',
      Buffer.from('x')
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ToolInputError);
    expect((error as Error).message).toContain('does not exist');
  });
});

describe('get_attachments to disk', () => {
  const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2000)]);
  const exe = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]);

  const withPdf = () =>
    mailbox({
      attachments: [
        {
          partId: '2',
          filename: 'invoice.pdf',
          contentType: 'application/pdf',
          content: pdf,
        },
      ],
    });

  it('saves a large binary and keeps its bytes out of the conversation', async () => {
    const harness = await connect({
      config: { imap: { downloadDir: directory } as never },
      mailboxes: withPdf(),
    });
    const result = await call(harness.client, 'get_attachments', {
      uid: 7,
      part_id: '2',
    });
    const payload = jsonOf(result) as { action: string; path: string };
    expect(payload.action).toBe('saved');
    expect(payload.path).toBe(join(directory, 'invoice.pdf'));
    expect(textOf(result)).not.toContain(pdf.toString('base64'));
    expect((await readFile(payload.path)).equals(pdf)).toBe(true);
    await harness.close();
  });

  it('refuses mode=file without a configured directory', async () => {
    const harness = await connect({ mailboxes: withPdf() });
    const result = await call(harness.client, 'get_attachments', {
      uid: 7,
      part_id: '2',
      mode: 'file',
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('IMAP_DOWNLOAD_DIR');
    await harness.close();
  });

  it('returns the content inline when asked, even with a directory set', async () => {
    const harness = await connect({
      config: { imap: { downloadDir: directory } as never },
      mailboxes: withPdf(),
    });
    const text = textOf(
      await call(harness.client, 'get_attachments', {
        uid: 7,
        part_id: '2',
        mode: 'inline',
      })
    );
    expect(text).toContain(pdf.toString('base64'));
    await harness.close();
  });

  it('keeps a small text part inline in auto mode', async () => {
    const harness = await connect({
      config: { imap: { downloadDir: directory } as never },
      mailboxes: mailbox({
        attachments: [
          {
            partId: '2',
            filename: 'notes.txt',
            contentType: 'text/plain',
            content: Buffer.from('Just a note.'),
          },
        ],
      }),
    });
    const text = textOf(
      await call(harness.client, 'get_attachments', { uid: 7, part_id: '2' })
    );
    expect(text).toContain('Just a note.');
    expect(text).not.toContain('"action": "saved"');
    await harness.close();
  });

  it('refuses to write an executable disguised as a PDF', async () => {
    const harness = await connect({
      config: { imap: { downloadDir: directory } as never },
      mailboxes: mailbox({
        attachments: [
          {
            partId: '2',
            filename: 'invoice.pdf',
            contentType: 'application/pdf',
            content: exe,
          },
        ],
      }),
    });
    const text = textOf(
      await call(harness.client, 'get_attachments', {
        uid: 7,
        part_id: '2',
        mode: 'file',
      })
    );
    expect(text).toContain('Refused');
    expect(text).toContain('executable');
    // Nothing was created: on disk a disguised binary is worse, not better.
    await expect(stat(join(directory, 'invoice.pdf'))).rejects.toThrow();
    await harness.close();
  });

  it('refuses a traversal filename without writing anywhere', async () => {
    const harness = await connect({
      config: { imap: { downloadDir: directory } as never },
      mailboxes: mailbox({
        attachments: [
          {
            partId: '2',
            filename: '../../etc/passwd.pdf',
            contentType: 'application/pdf',
            content: pdf,
          },
        ],
      }),
    });
    const payload = jsonOf(
      await call(harness.client, 'get_attachments', {
        uid: 7,
        part_id: '2',
        mode: 'file',
      })
    ) as { path: string };
    // Sanitised into the directory, not resolved out of it. The dots survive as
    // literal characters — harmless once the separators are gone, which is what
    // makes them incapable of traversing anywhere.
    expect(payload.path.startsWith(`${directory}/`)).toBe(true);
    expect(payload.path.slice(directory.length + 1)).not.toContain('/');
    expect(await readFile(payload.path)).toBeDefined();
    await harness.close();
  });

  it('applies the download limit rather than the inline one when saving', async () => {
    const harness = await connect({
      config: {
        imap: { downloadDir: directory, maxDownloadBytes: 100 } as never,
      },
      mailboxes: withPdf(),
    });
    const text = textOf(
      await call(harness.client, 'get_attachments', {
        uid: 7,
        part_id: '2',
        mode: 'file',
      })
    );
    expect(text).toContain('IMAP_MAX_DOWNLOAD_BYTES');
    await harness.close();
  });

  it('reports the configured directory in the listing', async () => {
    const harness = await connect({
      config: { imap: { downloadDir: directory } as never },
      mailboxes: withPdf(),
    });
    const payload = jsonOf(
      await call(harness.client, 'get_attachments', { uid: 7 })
    ) as { download_directory: string | null };
    expect(payload.download_directory).toBe(directory);
    await harness.close();
  });
});

const blobOf = (result: { contents: unknown[] }) =>
  Buffer.from((result.contents[0] as { blob: string }).blob, 'base64');

describe('attachment resources', () => {
  const pdf = Buffer.from('%PDF-1.7 body');

  async function harnessWithPdf() {
    return connect({
      mailboxes: [
        {
          path: 'INBOX',
          messages: [
            message(7, {
              attachments: [
                {
                  partId: '2',
                  filename: 'invoice.pdf',
                  contentType: 'application/pdf',
                  content: pdf,
                },
                {
                  partId: '3',
                  filename: 'setup.exe',
                  contentType: 'application/x-msdownload',
                  content: Buffer.from([0x4d, 0x5a, 0x00]),
                },
              ],
            }),
          ],
        },
      ],
    });
  }

  it('serves the attachment over the protocol', async () => {
    const harness = await harnessWithPdf();
    const result = await harness.client.readResource({
      uri: 'imap://message/7/part/2',
    });
    expect(result.contents[0]?.mimeType).toBe('application/pdf');
    expect(
      Buffer.from(
        (result.contents[0] as { blob?: string }).blob as string,
        'base64'
      ).equals(pdf)
    ).toBe(true);
    await harness.close();
  });

  it('applies the same policy as the tool — no second, unguarded door', async () => {
    const harness = await harnessWithPdf();
    await expect(
      harness.client.readResource({ uri: 'imap://message/7/part/3' })
    ).rejects.toThrow();
    await harness.close();
  });

  it('refuses a part id that is not an attachment of that message', async () => {
    const harness = await harnessWithPdf();
    await expect(
      harness.client.readResource({ uri: 'imap://message/7/part/1' })
    ).rejects.toThrow();
    await harness.close();
  });

  it('refuses a UID that does not exist', async () => {
    const harness = await harnessWithPdf();
    await expect(
      harness.client.readResource({ uri: 'imap://message/999/part/2' })
    ).rejects.toThrow();
    await harness.close();
  });

  it('refuses a URI whose UID or part id is not one, before any FETCH', async () => {
    // The template matches any text in either slot. What reaches the
    // connection has to be an integer and a dotted part number, the same
    // shapes the tool's schema enforces — validated here because a resource
    // has no schema.
    const harness = await harnessWithPdf();
    for (const uri of [
      'imap://message/seven/part/2',
      'imap://message/0/part/2',
      'imap://message/7/part/2a',
    ]) {
      await expect(harness.client.readResource({ uri }), uri).rejects.toThrow(
        /no valid (UID|MIME part id)/
      );
    }
    expect(harness.imap.calls.some((entry) => entry.name === 'download')).toBe(
      false
    );
    await harness.close();
  });

  describe('mailbox in the URI', () => {
    const other = Buffer.from('%PDF-1.7 other mailbox');

    function twoMailboxes() {
      return connect({
        mailboxes: [
          {
            path: 'INBOX',
            messages: [
              message(7, {
                attachments: [
                  {
                    partId: '2',
                    filename: 'inbox.pdf',
                    contentType: 'application/pdf',
                    content: pdf,
                  },
                ],
              }),
            ],
          },
          {
            path: 'INBOX/Rechnungen',
            messages: [
              message(7, {
                attachments: [
                  {
                    partId: '2',
                    filename: 'other.pdf',
                    contentType: 'application/pdf',
                    content: other,
                  },
                ],
              }),
            ],
          },
        ],
      });
    }

    it('reads the message of the named mailbox, not UID n of the default one', async () => {
      const harness = await twoMailboxes();
      const result = await harness.client.readResource({
        uri: 'imap://message/7/part/2?mailbox=INBOX%2FRechnungen',
      });
      expect(blobOf(result).equals(other)).toBe(true);
      expect(
        harness.imap.calls.some(
          (entry) =>
            entry.name === 'getMailboxLock' &&
            entry.args[0] === 'INBOX/Rechnungen'
        )
      ).toBe(true);
      await harness.close();
    });

    it('keeps the form without a mailbox working for the default one', async () => {
      const harness = await twoMailboxes();
      const result = await harness.client.readResource({
        uri: 'imap://message/7/part/2',
      });
      expect(blobOf(result).equals(pdf)).toBe(true);
      await harness.close();
    });

    it('advertises both templates', async () => {
      const harness = await twoMailboxes();
      const { resourceTemplates } =
        await harness.client.listResourceTemplates();
      expect(resourceTemplates.map((t) => t.uriTemplate).toSorted()).toEqual([
        'imap://message/{uid}/part/{partId}',
        'imap://message/{uid}/part/{partId}{?mailbox}',
      ]);
      await harness.close();
    });

    it.each([
      'imap://message/7/part/2?mailbox=',
      'imap://message/7/part/2?mailbox=%2A',
      'imap://message/7/part/2?mailbox=a%0Ab',
    ])('refuses the mailbox in %s before any FETCH', async (uri) => {
      const harness = await twoMailboxes();
      await expect(harness.client.readResource({ uri })).rejects.toThrow();
      expect(
        harness.imap.calls.some((entry) => entry.name === 'download')
      ).toBe(false);
      await harness.close();
    });

    it('does not take the query for part of the part id', async () => {
      const harness = await twoMailboxes();
      await expect(
        harness.client.readResource({
          uri: 'imap://message/7/part/2?other=1',
        })
      ).rejects.toThrow(/no valid MIME part id/);
      await harness.close();
    });
  });

  it.each([
    'imap://message/0x10/part/2',
    'imap://message/1e1/part/2',
    'imap://message/07/part/2',
    'imap://message/+7/part/2',
    'imap://message/7.0/part/2',
    'imap://message/4294967296/part/2',
    'imap://message/12345678901/part/2',
  ])('reads %s strictly: not a UID', async (uri) => {
    // Number() accepts every one of these as a number.
    const harness = await harnessWithPdf();
    await expect(harness.client.readResource({ uri })).rejects.toThrow(
      /no valid UID/
    );
    await harness.close();
  });

  it('accepts the largest UID', async () => {
    const harness = await harnessWithPdf();
    await expect(
      harness.client.readResource({ uri: 'imap://message/4294967295/part/2' })
    ).rejects.toThrow(/no message with UID 4294967295/);
    await harness.close();
  });

  it('puts an error through the same escaping as a tool error', async () => {
    // The library quotes the mailbox it could not open, and a mailbox name may
    // carry a directional override. A tool result spells it out; so must this.
    const harness = await harnessWithPdf();
    const error = await harness.client
      .readResource({
        uri: `imap://message/7/part/2?mailbox=${encodeURIComponent('no\u202esuch')}`,
      })
      .catch((caught: unknown) => caught as Error);
    const text = String((error as Error).message);
    expect(text).toContain("Mailbox doesn't exist");
    expect(text).not.toContain('\u202e');
    await harness.close();
  });

  it('labels the blob with the type of the bytes for an image', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
    const harness = await connect({
      mailboxes: mailbox({
        attachments: [
          {
            partId: '2',
            filename: 'a.png',
            contentType: 'image/png',
            content: jpeg,
          },
          {
            partId: '3',
            filename: 'b.png',
            contentType: 'image/png',
            content: Buffer.from('<svg onload="x()"/>'),
          },
        ],
      }),
    });
    const real = await harness.client.readResource({
      uri: 'imap://message/7/part/2',
    });
    expect(real.contents[0]?.mimeType).toBe('image/jpeg');
    const fake = await harness.client.readResource({
      uri: 'imap://message/7/part/3',
    });
    expect(fake.contents[0]?.mimeType).toBe('application/octet-stream');
    await harness.close();
  });

  it('refuses a content one byte over the cap although the declaration says it fits', async () => {
    const harness = await connect({
      config: { imap: { ...testConfig().imap, maxAttachmentBytes: 64 } },
      mailboxes: mailbox({
        attachments: [
          {
            partId: '2',
            filename: 'a.txt',
            contentType: 'text/plain',
            content: Buffer.alloc(65, 0x61),
            declaredSize: 10,
          },
        ],
      }),
    });
    await expect(
      harness.client.readResource({ uri: 'imap://message/7/part/2' })
    ).rejects.toThrow(/IMAP_MAX_ATTACHMENT_BYTES/);
    await harness.close();
  });

  it('says why a script declared as text/plain is refused', async () => {
    const harness = await connect({
      mailboxes: mailbox({
        attachments: [
          {
            partId: '2',
            filename: 'notes.txt',
            contentType: 'text/plain',
            content: Buffer.from('#!/bin/sh\necho hi\n'),
          },
        ],
      }),
    });
    await expect(
      harness.client.readResource({ uri: 'imap://message/7/part/2' })
    ).rejects.toThrow(/starts with "#!"/);
    await harness.close();
  });

  it('is closed by the tool filter along with get_attachments', async () => {
    // The resource is the same door as the tool. Denying the tool used to
    // remove it from tools/list and leave imap://message/{uid}/part/{partId}
    // fully live — a narrowing that looked complete and was not.
    const harness = await connect({
      config: { denyTools: 'get_attachments' },
      mailboxes: [
        {
          path: 'INBOX',
          messages: [
            message(7, {
              attachments: [
                {
                  partId: '2',
                  filename: 'invoice.pdf',
                  contentType: 'application/pdf',
                  content: pdf,
                },
              ],
            }),
          ],
        },
      ],
    });
    // Nothing is registered, so the server does not advertise the resource
    // capability at all and the read fails. Both are the same answer a client
    // gets for a tool the filter removed: this server does not have that.
    expect(harness.client.getServerCapabilities()?.resources).toBeUndefined();
    await expect(
      harness.client.readResource({ uri: 'imap://message/7/part/2' })
    ).rejects.toThrow();
    await harness.close();
  });

  it('bounds the resource by the inline budget, not the disk one', async () => {
    // The bytes come back base64 in a JSON-RPC response, so they are context.
    // maxDownloadBytes (25 MB by default) bounds what may be written to a file;
    // using it here allowed ~34 MB of base64 in one response, where
    // get_attachments caps the same attachment at 1 MB.
    const big = Buffer.concat([pdf, Buffer.alloc(4096, 0x20)]);
    const harness = await connect({
      config: {
        imap: {
          ...testConfig().imap,
          maxAttachmentBytes: 1024,
          maxDownloadBytes: 25 * 1024 * 1024,
        },
      },
      mailboxes: [
        {
          path: 'INBOX',
          messages: [
            message(7, {
              attachments: [
                {
                  partId: '2',
                  filename: 'invoice.pdf',
                  contentType: 'application/pdf',
                  content: big,
                },
              ],
            }),
          ],
        },
      ],
    });
    await expect(
      harness.client.readResource({ uri: 'imap://message/7/part/2' })
    ).rejects.toThrow(/IMAP_MAX_ATTACHMENT_BYTES/);
    await harness.close();
  });
});

function mailbox(attachments: Parameters<typeof message>[1]) {
  return [{ path: 'INBOX', messages: [message(7, attachments)] }];
}

describe('the download deadline', () => {
  it('grows with the cap and never drops below the command timeout', async () => {
    const { downloadDeadline } = await import('../src/stream.js');
    expect(downloadDeadline(0)).toBe(30_000);
    expect(downloadDeadline(1)).toBe(40_000);
    expect(downloadDeadline(25 * 1024 * 1024)).toBe(280_000);
    // A started MiB counts whole: on the boundary, and one byte past it.
    expect(downloadDeadline(1024 * 1024)).toBe(40_000);
    expect(downloadDeadline(1024 * 1024 + 1)).toBe(50_000);
  });
});

describe('a download that trickles', () => {
  it('gives up at the deadline instead of holding the mailbox', async () => {
    const { PassThrough } = await import('node:stream');
    const { downloadCapped } = await import('../src/stream.js');
    vi.useFakeTimers();
    try {
      const stream = new PassThrough();
      stream.write(Buffer.from('a'));
      const connection = {
        download: async () => ({
          content: stream,
          meta: { contentType: 'text/plain' },
        }),
      } as never;
      const pending = downloadCapped(connection, 1, '2', 1024);
      const assertion = expect(pending).rejects.toMatchObject({
        code: 'COMMAND_TIMEOUT',
      });
      await vi.advanceTimersByTimeAsync(41_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
