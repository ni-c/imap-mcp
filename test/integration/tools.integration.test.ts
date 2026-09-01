import { readdir } from 'node:fs/promises';

import {
  expectEveryToolExercised,
  startServer,
  toolCoverage,
  tokenOf,
  type LiveHarness,
} from 'mcp-integration-harness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_TOOLS } from '../../src/tools/catalogue.js';
import { bootstrap, SUBJECTS, type Sandbox } from './bootstrap.js';

/**
 * Every tool in the catalogue, against a real IMAP server in Docker.
 *
 * The unit tests drive an in-memory fake, so what they establish is that this
 * server handles the IMAP responses its author expected. Here the messages
 * were delivered over a real SMTP dialogue into a real store, so what the read
 * tools parse is an actual RFC 5322 message with actual MIME parts — and the
 * write tools talk to a server that has its own opinions about flags,
 * expunging and mailbox names.
 *
 * Order matters and state is shared: messages seeded once at the top are
 * flagged, moved and finally deleted further down.
 */

let sandbox: Sandbox;
/** Declares elicitation, so guarded tools go through the real dialog. */
let asking: LiveHarness;
/** Declares none, so the same tools fall back to the two-call token. */
let plain: LiveHarness;

function parse<T>(text: string): T {
  const start = text.indexOf('{');
  if (start === -1) throw new Error(`no JSON in result: ${text.slice(0, 300)}`);
  return JSON.parse(text.slice(start)) as T;
}

interface Listing {
  messages: { uid: number; subject: string; flags?: string[] }[];
}

/** The uid of a seeded message, by subject. */
async function uidOf(subject: string, mailbox = 'INBOX'): Promise<number> {
  const listed = parse<Listing>(
    await asking.call('list_messages', { mailbox, limit: 50 })
  );
  const found = listed.messages.find((m) => m.subject === subject);
  if (found === undefined) {
    throw new Error(
      `no message titled "${subject}" in ${mailbox}; saw ` +
        listed.messages.map((m) => m.subject).join(', ')
    );
  }
  return found.uid;
}

beforeAll(async () => {
  sandbox = await bootstrap();
  asking = await startServer({ env: sandbox.env, elicit: 'accept' });
  plain = await startServer({ env: sandbox.env });
}, 600_000);

afterAll(async () => {
  await asking?.close();
  await plain?.close();
});

describe('the server and its mailboxes', () => {
  it('reports what this IMAP server can do', async () => {
    const info = await asking.call('get_server_info');
    expect(info).toContain('IMAP4rev1');
    // GreenMail advertises MOVE and UIDPLUS, which is what makes the move and
    // expunge paths take their fast branches rather than the fallbacks.
    expect(info).toContain('MOVE');
    expect(info).toContain('"write_tools_enabled": true');
    // The password must not come back out.
    expect(info).not.toContain('integration-not-a-secret');
  });

  it('lists the mailboxes the account has', async () => {
    expect(await asking.call('list_mailboxes')).toContain('INBOX');
  });
});

describe('reading what was delivered', () => {
  it('lists the seeded messages', async () => {
    const listed = await asking.call('list_messages', { limit: 50 });
    for (const subject of sandbox.subjects) {
      expect(listed).toContain(subject);
    }
  });

  it('reads one in full, as it came off the wire', async () => {
    const uid = await uidOf(SUBJECTS.first);
    const message = await asking.call('get_message', { uid });
    expect(message).toContain(SUBJECTS.first);
    expect(message).toContain('sender@example.org');
    expect(message).toContain(`Body of "${SUBJECTS.first}"`);
  });

  it('frames the mailbox as untrusted, on every read', async () => {
    // Not decoration: anybody in the world can put a message in this mailbox,
    // so the preamble is what stops a subject line reading as an instruction.
    // It has to be on the real content, not only on the fixture.
    expect(await asking.call('list_messages', { limit: 5 })).toMatch(
      /^The following comes from the mailbox/
    );
  });

  it('answers what is new, and stops saying so once it has been read', async () => {
    const first = parse<Listing>(await asking.call('list_new_messages'));
    expect(first.messages.length).toBeGreaterThan(0);
    // The keyword this server sets is its own, not \Seen — reading a message
    // through a tool must not mark it read in somebody's mail client.
    const again = parse<Listing>(await asking.call('list_new_messages'));
    expect(again.messages).toHaveLength(0);
  });

  it('lists the parts of a real multipart message without fetching any', async () => {
    // Two calls by design: without a `part_id` the tool lists, so a model can
    // see the filenames and sizes before deciding to pull megabytes through
    // its own context. Nothing is fetched and nothing is written.
    const uid = await uidOf(SUBJECTS.attachment);
    const listed = parse<{
      attachments: { part_id: string; filename: string }[];
    }>(await asking.call('get_attachments', { uid }));
    expect(listed.attachments).toHaveLength(1);
    expect(listed.attachments[0]!.filename).toBe('report.txt');
    expect(await readdir(sandbox.downloadDir)).toHaveLength(0);
  });

  it('reads a small one inline, and writes it to disk when asked', async () => {
    const uid = await uidOf(SUBJECTS.attachment);
    const listed = parse<{ attachments: { part_id: string }[] }>(
      await asking.call('get_attachments', { uid })
    );
    const partId = listed.attachments[0]!.part_id;

    // "auto" reads small text inline: the bytes come back and nothing is
    // written, which is what makes the default safe for a shared machine.
    const inline = await asking.call('get_attachments', {
      uid,
      part_id: partId,
    });
    expect(inline).toContain('integration attachment');
    expect(await readdir(sandbox.downloadDir)).toHaveLength(0);

    // "file" is the half a fake cannot check: real bytes in the directory the
    // operator named, and nowhere else.
    await asking.call('get_attachments', {
      uid,
      part_id: partId,
      mode: 'file',
    });
    const files = await readdir(sandbox.downloadDir);
    expect(files.some((name) => name.includes('report'))).toBe(true);
  });
});

describe('flags, mailboxes and moving', () => {
  it('sets and clears a flag', async () => {
    const uid = await uidOf(SUBJECTS.first);
    await asking.call('set_message_flags', {
      uids: [uid],
      add: ['\\Flagged'],
    });
    const listed = parse<Listing>(
      await asking.call('list_messages', { limit: 50 })
    );
    expect(listed.messages.find((m) => m.uid === uid)?.flags).toContain(
      '\\Flagged'
    );

    await asking.call('set_message_flags', {
      uids: [uid],
      remove: ['\\Flagged'],
    });
    const after = parse<Listing>(
      await asking.call('list_messages', { limit: 50 })
    );
    expect(
      after.messages.find((m) => m.uid === uid)?.flags ?? []
    ).not.toContain('\\Flagged');
  });

  it('creates a mailbox, moves a message into it, and removes it again', async () => {
    await asking.call('manage_mailbox', {
      action: 'create',
      mailbox: 'Integration',
    });
    expect(await asking.call('list_mailboxes')).toContain('Integration');

    const uid = await uidOf(SUBJECTS.toMove);
    await asking.call('move_messages', {
      uids: [uid],
      destination: 'Integration',
    });

    // Gone from INBOX, present in the destination: a move is two operations
    // against a real server and only one of them is easy to get right.
    const inbox = parse<Listing>(
      await asking.call('list_messages', { limit: 50 })
    );
    expect(inbox.messages.map((m) => m.subject)).not.toContain(SUBJECTS.toMove);
    const moved = parse<Listing>(
      await asking.call('list_messages', {
        mailbox: 'Integration',
        limit: 50,
      })
    );
    expect(moved.messages.map((m) => m.subject)).toContain(SUBJECTS.toMove);

    await asking.call('manage_mailbox', {
      action: 'delete',
      mailbox: 'Integration',
    });
    expect(await asking.call('list_mailboxes')).not.toContain('Integration');
  });

  it('saves a draft into the drafts mailbox', async () => {
    await asking.call('manage_mailbox', {
      action: 'create',
      mailbox: 'Drafts',
    });
    await asking.call('save_draft', {
      to: ['someone@example.net'],
      subject: 'Integration draft',
      body: 'Written by the integration suite.',
    });
    const drafts = await asking.call('list_messages', {
      mailbox: 'Drafts',
      limit: 10,
    });
    expect(drafts).toContain('Integration draft');
  });
});

describe('the fallback path for a client with no dialog', () => {
  it('expunges only after the token comes back', async () => {
    const listed = parse<Listing>(
      await plain.call('list_messages', { limit: 50 })
    );
    const target = listed.messages.find((m) => m.subject === SUBJECTS.toDelete);
    expect(target).toBeDefined();

    const refusal = await plain.call('delete_messages', {
      uids: [target!.uid],
    });
    expect(refusal).toContain('confirm_token');
    expect(plain.prompts).toHaveLength(0);
    // Still there: the first call is a question.
    const before = parse<Listing>(
      await plain.call('list_messages', { limit: 50 })
    );
    expect(before.messages.map((m) => m.subject)).toContain(SUBJECTS.toDelete);

    await plain.call('delete_messages', {
      uids: [target!.uid],
      confirm_token: tokenOf(refusal),
    });
    const after = parse<Listing>(
      await plain.call('list_messages', { limit: 50 })
    );
    expect(after.messages.map((m) => m.subject)).not.toContain(
      SUBJECTS.toDelete
    );
  });

  it('asked a person on one harness and nobody on the other', () => {
    expect(asking.prompts.length).toBeGreaterThan(0);
    expect(plain.prompts).toHaveLength(0);
  });
});

it('exercises every tool in the catalogue', () => {
  const called = new Set([...asking.called, ...plain.called]);
  const report = toolCoverage({ called }, ALL_TOOLS, {});
  console.log(
    `imap-mcp: ${report.called.length}/${ALL_TOOLS.length} tools against a real IMAP server`
  );
  expectEveryToolExercised({ called }, ALL_TOOLS, {});
});
