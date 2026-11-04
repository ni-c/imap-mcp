import { afterEach, describe, expect, it, vi } from 'vitest';

import { auditedWrite } from '../src/audit.js';
import { MailError, ToolInputError } from '../src/errors.js';
import {
  CANCELLED,
  COMMAND_TIMEOUT,
  ImapClient,
  requireOk,
  withTimeout,
  type ImapConnection,
} from '../src/imap.js';
import { run } from '../src/result.js';

import {
  closedUnder,
  FakeImap,
  held,
  message,
  queueLocks,
  stalledUntilClosed,
} from './fake-imap.js';
import { call, connect, jsonOf, testConfig, tokenOf } from './harness.js';

/**
 * Several calls share one IMAP connection, and imapflow keeps exactly one
 * command of theirs on the wire; the others wait behind it. Closing the
 * connection rejects the command on the wire and every one queued behind it,
 * all with the same NoConnection. These tests pin what a call that fails or is
 * cancelled may do to the calls it shares the connection with.
 */

const boxes = () => [
  { path: 'INBOX', messages: [message(1), message(2)] },
  { path: 'Drafts', messages: [] },
  { path: 'Archive', messages: [] },
];

const connects = (fake: FakeImap) =>
  fake.calls.filter((entry) => entry.name === 'connect').length;

function lost(code: string, rejectedFrom?: string): Error {
  return Object.assign(new Error('Connection not available'), {
    code,
    ...(rejectedFrom === undefined ? {} : { rejectedFrom }),
  });
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a call cancelled while another call works on the connection', () => {
  it("leaves the other call's APPEND on the wire alone and closes only after it", async () => {
    const first = new FakeImap(boxes());
    const second = new FakeImap(boxes());
    const fakes = [first, second];
    const client = new ImapClient(testConfig(), () => fakes.shift()!);
    const append = held(first, { path: 'Drafts', uid: 7 });
    first.append = () => append.run() as never;
    const list = held(first, [] as never);
    first.list = () => list.run() as never;
    const closed = vi.spyOn(first, 'close');

    const draft = client.withMailbox('Drafts', false, undefined, (c) =>
      c.append('Drafts', 'draft', ['\\Draft'])
    );
    await append.began;
    const controller = new AbortController();
    const listing = client.listMailboxes(controller.signal);
    await list.began;
    controller.abort();
    await expect(listing).rejects.toMatchObject({ code: CANCELLED });
    expect(closed).not.toHaveBeenCalled();

    // A call made now does not queue behind the abandoned LIST.
    await expect(
      client.withMailbox('INBOX', true, undefined, async () => 'fresh')
    ).resolves.toBe('fresh');
    expect(connects(second)).toBe(1);

    append.release();
    await expect(draft).resolves.toMatchObject({ uid: 7 });
    expect(append.count).toBe(1);
    // The set-aside connection is closed once the last command on it is done,
    // the abandoned LIST included.
    expect(closed).not.toHaveBeenCalled();
    list.release();
    await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
  });

  it("keeps a cancelled holder's lock until its MOVE is done, and sends a waiter to a fresh connection", async () => {
    const first = new FakeImap(boxes());
    const second = new FakeImap(boxes());
    const fakes = [first, second];
    queueLocks(first);
    const queued = first.getMailboxLock;
    let requests = 0;
    first.getMailboxLock = (...args) => {
      requests += 1;
      return queued(...args);
    };
    const client = new ImapClient(testConfig(), () => fakes.shift()!);
    const list = held(first, [] as never);
    first.list = () => list.run() as never;
    const move = held(first, { path: 'INBOX', destination: 'Archive' });
    first.messageMove = () => move.run() as never;

    const other = client.listMailboxes(undefined);
    await list.began;
    const controller = new AbortController();
    const moving = client.withMailbox('INBOX', false, controller.signal, (c) =>
      c.messageMove([1], 'Archive', { uid: true })
    );
    await move.began;
    const waiting = client.withMailbox(
      'INBOX',
      true,
      undefined,
      async () => 'waited'
    );
    await vi.waitFor(() => expect(requests).toBe(2));
    controller.abort();
    await expect(moving).rejects.toMatchObject({ code: CANCELLED });

    // The waiter does not sit behind the abandoned MOVE.
    await expect(waiting).resolves.toBe('waited');
    expect(connects(second)).toBe(1);
    // No other SELECT may come between the MOVE and whatever imapflow sends
    // after it, so the cancelled call keeps INBOX until the MOVE is done.
    expect(first.openLocks).toBe(1);
    move.release();
    await vi.waitFor(() => expect(first.openLocks).toBe(0));
    list.release();
    await expect(other).resolves.toMatchObject({ total: 0 });
    await vi.waitFor(() => expect(first.connected).toBe(false));
  });

  it('sends nothing further for the cancelled call while the connection stays up', async () => {
    const fake = new FakeImap(boxes());
    const client = new ImapClient(testConfig(), () => fake);
    const listing = held(fake, [] as never);
    fake.list = () => listing.run() as never;
    const search = held(fake, [1]);
    fake.search = () => search.run() as never;
    let moves = 0;
    fake.messageMove = async () => {
      moves += 1;
      return { path: 'INBOX', destination: 'Archive' } as never;
    };

    // A lockless listing keeps the connection busy …
    const other = client.listMailboxes(undefined);
    await listing.began;
    // … while a move is cancelled during its SEARCH.
    const controller = new AbortController();
    const moving = client.withMailbox(
      'INBOX',
      false,
      controller.signal,
      async (c) => {
        await c.search({ all: true }, { uid: true });
        return c.messageMove([1], 'Archive', { uid: true });
      }
    );
    await search.began;
    controller.abort();
    await expect(moving).rejects.toMatchObject({ code: CANCELLED });

    search.release();
    listing.release();
    await expect(other).resolves.toMatchObject({ total: 0 });
    await vi.waitFor(() => expect(fake.connected).toBe(false));
    expect(moves).toBe(0);
  });

  it('still closes at once when it is the only call on the connection', async () => {
    const fake = new FakeImap(boxes());
    const client = new ImapClient(testConfig(), () => fake);
    const search = held(fake, [1]);
    fake.search = () => search.run() as never;
    const closed = vi.spyOn(fake, 'close');
    const controller = new AbortController();
    const pending = client.withMailbox('INBOX', true, controller.signal, (c) =>
      c.search({ all: true }, { uid: true })
    );
    await search.began;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: CANCELLED });
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('closes a set-aside connection when the client closes', async () => {
    const first = new FakeImap(boxes());
    const second = new FakeImap(boxes());
    const fakes = [first, second];
    const client = new ImapClient(testConfig(), () => fakes.shift()!);
    const list = held(first, [] as never);
    first.list = () => list.run() as never;
    const search = held(first, [1]);
    first.search = () => search.run() as never;
    const other = client.listMailboxes(undefined).catch(() => undefined);
    await list.began;
    const controller = new AbortController();
    const searching = client.withMailbox(
      'INBOX',
      true,
      controller.signal,
      (c) => c.search({ all: true }, { uid: true })
    );
    await search.began;
    controller.abort();
    await expect(searching).rejects.toMatchObject({ code: CANCELLED });
    // Set aside, not closed: the listing is still running on it.
    expect(first.connected).toBe(true);
    await client.close();
    expect(first.connected).toBe(false);
    await other;
  });
});

function holderAndWaiter() {
  vi.useFakeTimers();
  const fake = new FakeImap(boxes());
  queueLocks(fake);
  const config = testConfig();
  config.imap.commandTimeoutMs = 1_000;
  const client = new ImapClient(config, () => fake);
  const closed = vi.spyOn(fake, 'close');
  const search = held(fake, [] as number[]);
  fake.search = () => search.run() as never;
  const move = held(fake, { path: 'INBOX', destination: 'Archive' });
  fake.messageMove = () => move.run() as never;
  // Like move_messages: a SEARCH first, then the MOVE, each with its deadline.
  const holder = client.withMailbox('INBOX', false, undefined, async (c) => {
    await withTimeout(
      c.search({ deleted: true }, { uid: true }),
      'SEARCH',
      1_000
    );
    return requireOk(
      await withTimeout(
        c.messageMove([1], 'Archive', { uid: true }),
        'MOVE',
        1_000
      ),
      'MOVE'
    );
  });
  return { fake, client, closed, search, move, holder };
}

describe('a STATUS past its deadline while another call works on the connection', () => {
  it('sets the connection aside and closes it once that call is done', async () => {
    vi.useFakeTimers();
    const fake = new FakeImap(boxes());
    fake.capabilities.delete('LIST-STATUS');
    fake.status = () => new Promise<never>(() => {});
    const config = testConfig();
    config.imap.commandTimeoutMs = 1_000;
    const client = new ImapClient(config, () => fake);
    const search = held(fake, [1]);
    fake.search = () => search.run() as never;
    const closed = vi.spyOn(fake, 'close');

    const reading = client.withMailbox('INBOX', true, undefined, (c) =>
      c.search({ all: true }, { uid: true })
    );
    await search.began;
    let omitted: number | undefined;
    void client.listMailboxes(undefined).then((listing) => {
      omitted = listing.statusOmitted;
    });
    await vi.advanceTimersByTimeAsync(1_001);
    expect(omitted).toBe(3);
    // The SEARCH of the other call is still on this connection.
    expect(closed).not.toHaveBeenCalled();
    search.release();
    await expect(reading).resolves.toEqual([1]);
    await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
  });
});

describe('a call that only waits for the mailbox lock', () => {
  it("gives up with MAILBOX_BUSY and leaves the holder's MOVE on the wire alone", async () => {
    const { fake, client, closed, search, move, holder } = holderAndWaiter();
    await search.began;
    const waiter = client
      .withMailbox('INBOX', true, undefined, async () => 'x')
      .catch((error: unknown) => error);
    // The MOVE goes out at 0.6 s, due at 1.6 s; the waiter's 1 s pass at 1.0 s.
    await vi.advanceTimersByTimeAsync(600);
    search.release();
    await vi.advanceTimersByTimeAsync(500);
    expect(await waiter).toMatchObject({ code: 'MAILBOX_BUSY' });
    expect(closed).not.toHaveBeenCalled();
    move.release();
    await vi.advanceTimersByTimeAsync(0);
    await expect(holder).resolves.toMatchObject({ destination: 'Archive' });
    expect(move.count).toBe(1);
    // Granted after the waiter left: taken and handed back, not leaked.
    await vi.waitFor(() => expect(fake.openLocks).toBe(0));
  });

  it('does the same when it is cancelled instead', async () => {
    const { client, closed, search, move, holder } = holderAndWaiter();
    await search.began;
    const controller = new AbortController();
    const waiter = client.withMailbox(
      'INBOX',
      true,
      controller.signal,
      async () => 'x'
    );
    await vi.advanceTimersByTimeAsync(600);
    search.release();
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await expect(waiter).rejects.toMatchObject({ code: CANCELLED });
    expect(closed).not.toHaveBeenCalled();
    move.release();
    await vi.advanceTimersByTimeAsync(0);
    await expect(holder).resolves.toMatchObject({ destination: 'Archive' });
    expect(move.count).toBe(1);
  });

  it('closes the connection when its own SELECT is stuck and nobody else works on it', async () => {
    vi.useFakeTimers();
    const fake = new FakeImap(boxes());
    fake.getMailboxLock = () => stalledUntilClosed(fake);
    const config = testConfig();
    config.imap.commandTimeoutMs = 1_000;
    const client = new ImapClient(config, () => fake);
    const closed = vi.spyOn(fake, 'close');
    const pending = client
      .withMailbox('INBOX', true, undefined, async () => 'x')
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await pending).toMatchObject({ code: COMMAND_TIMEOUT });
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('closes the connection when it is cancelled during its own SELECT and nobody else works on it', async () => {
    const fake = new FakeImap(boxes());
    let selecting!: () => void;
    const started = new Promise<void>((resolve) => {
      selecting = resolve;
    });
    fake.getMailboxLock = () => {
      selecting();
      return stalledUntilClosed(fake);
    };
    const client = new ImapClient(testConfig(), () => fake);
    const closed = vi.spyOn(fake, 'close');
    const controller = new AbortController();
    const pending = client.withMailbox(
      'INBOX',
      true,
      controller.signal,
      async () => 'x'
    );
    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: CANCELLED });
    expect(closed).toHaveBeenCalledTimes(1);
  });
});

describe('which failed calls are repeated', () => {
  it('does not repeat an APPEND the connection dropped under', async () => {
    const fake = new FakeImap(boxes());
    const client = new ImapClient(testConfig(), () => fake);
    let appends = 0;
    fake.append = async () => {
      appends += 1;
      throw lost('NoConnection', 'pendingRequest');
    };
    await expect(
      client.withMailbox('Drafts', false, undefined, (c) =>
        c.append('Drafts', 'x', [])
      )
    ).rejects.toMatchObject({ code: 'NoConnection' });
    expect(appends).toBe(1);
  });

  it('does not repeat a write when imapflow does not say where it failed', async () => {
    const fake = new FakeImap(boxes());
    const client = new ImapClient(testConfig(), () => fake);
    let appends = 0;
    fake.append = async () => {
      appends += 1;
      throw lost('ECONNRESET');
    };
    await expect(
      client.withMailbox('Drafts', false, undefined, (c) =>
        c.append('Drafts', 'x', [])
      )
    ).rejects.toMatchObject({ code: 'ECONNRESET' });
    expect(appends).toBe(1);
  });

  it.each([
    ['NoConnection', 'execClosed'],
    ['EConnectionClosed', 'execNoSocket'],
    ['NoConnection', 'writeNoSocket'],
    ['NoConnection', 'sendAfterLogout'],
    ['NoConnection', 'noSocket'],
    ['StateLogout', 'writeAfterLogout'],
    ['NoConnection', 'preCheckWaiter'],
  ])('repeats a write imapflow never sent (%s, %s)', async (code, site) => {
    const fake = new FakeImap(boxes());
    const client = new ImapClient(testConfig(), () => fake);
    const append = fake.append.bind(fake);
    let appends = 0;
    fake.append = async (...args) => {
      appends += 1;
      if (appends === 1) throw lost(code, site);
      return append(...args);
    };
    await expect(
      client.withMailbox('Drafts', false, undefined, (c) =>
        c.append('Drafts', 'x', [])
      )
    ).resolves.toMatchObject({ path: 'Drafts' });
    expect(appends).toBe(2);
  });

  it('repeats a write whose mailbox lock could not be taken', async () => {
    const fake = new FakeImap(boxes());
    const client = new ImapClient(testConfig(), () => fake);
    const lock = fake.getMailboxLock.bind(fake);
    let locks = 0;
    fake.getMailboxLock = async (...args) => {
      locks += 1;
      if (locks === 1) throw lost('NoConnection', 'pendingRequest');
      return lock(...args);
    };
    let runs = 0;
    await expect(
      client.withMailbox('Drafts', false, undefined, async () => {
        runs += 1;
        return 'written';
      })
    ).resolves.toBe('written');
    expect(runs).toBe(1);
  });

  it('repeats a read the connection dropped under', async () => {
    const fake = new FakeImap(boxes());
    const client = new ImapClient(testConfig(), () => fake);
    let searches = 0;
    const search = fake.search.bind(fake);
    fake.search = async (...args) => {
      searches += 1;
      if (searches === 1) throw lost('NoConnection', 'pendingRequest');
      return search(...args);
    };
    await expect(
      client.withMailbox('INBOX', true, undefined, (c) =>
        c.search({ all: true }, { uid: true })
      )
    ).resolves.toEqual([1, 2]);
    expect(searches).toBe(2);
  });

  it('repeats a listing on a code only reads are repeated on', async () => {
    const fake = new FakeImap(boxes());
    const client = new ImapClient(testConfig(), () => fake);
    const list = fake.list.bind(fake);
    let lists = 0;
    fake.list = async (...args) => {
      lists += 1;
      if (lists === 1) throw lost('EConnectionClosed');
      return list(...args);
    };
    await expect(client.listMailboxes(undefined)).resolves.toMatchObject({
      total: 3,
    });
    expect(lists).toBe(2);
  });
});

describe('a write refused on a connection that is gone', () => {
  const gone = { usable: false } as unknown as ImapConnection;
  const up = { usable: true } as unknown as ImapConnection;

  it('is reported as possibly carried out, not as refused', () => {
    expect(codeOf(() => requireOk(false, 'MOVE', gone))).toBe('NoConnection');
    expect(() => requireOk(false, 'MOVE', gone)).toThrow(/may have/);
  });

  it.each([
    ['the connection is up', up],
    ['there is no connection to ask', undefined],
  ])('stays a refusal when %s', (_case, connection) => {
    expect(codeOf(() => requireOk(false, 'MOVE', connection))).toBe(
      'COMMAND_REFUSED'
    );
  });

  it.each([null, undefined])('treats %s like false', (answer) => {
    expect(codeOf(() => requireOk(answer, 'MOVE', gone))).toBe('NoConnection');
    expect(codeOf(() => requireOk(answer, 'MOVE', up))).toBe('COMMAND_REFUSED');
  });

  it('passes an answer through whatever the connection says', () => {
    expect(requireOk({ ok: 1 }, 'MOVE', gone)).toEqual({ ok: 1 });
  });
});

describe('every write a call starts', () => {
  // Each counts until imapflow says it never left; one that may have reached the
  // server keeps the whole call from being repeated.
  it.each([
    ['append', (c: ImapConnection) => c.append('Drafts', 'x', [])],
    [
      'messageFlagsAdd',
      (c: ImapConnection) => c.messageFlagsAdd([1], ['\\Seen'], { uid: true }),
    ],
    [
      'messageFlagsRemove',
      (c: ImapConnection) =>
        c.messageFlagsRemove([1], ['\\Seen'], { uid: true }),
    ],
    [
      'messageCopy',
      (c: ImapConnection) => c.messageCopy([1], 'Archive', { uid: true }),
    ],
    [
      'messageMove',
      (c: ImapConnection) => c.messageMove([1], 'Archive', { uid: true }),
    ],
    [
      'messageDelete',
      (c: ImapConnection) => c.messageDelete([1], { uid: true }),
    ],
    ['mailboxCreate', (c: ImapConnection) => c.mailboxCreate('New')],
    ['mailboxRename', (c: ImapConnection) => c.mailboxRename('Archive', 'Old')],
    ['mailboxDelete', (c: ImapConnection) => c.mailboxDelete('Archive')],
  ] as const)(
    'keeps a call whose %s may have gone out from being repeated',
    async (method, write) => {
      const fake = new FakeImap(boxes());
      const client = new ImapClient(testConfig(), () => fake);
      let calls = 0;
      Object.assign(fake, {
        [method]: async () => {
          calls += 1;
          throw closedUnder();
        },
      });
      await expect(
        client.withMailbox(
          'INBOX',
          false,
          undefined,
          (c) => write(c) as Promise<unknown>
        )
      ).rejects.toMatchObject({ code: 'NoConnection' });
      expect(calls).toBe(1);
    }
  );
});

function auditLines(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  return lines;
}

function errorOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('the audit line of a write whose outcome is unknown', () => {
  it.each([
    [
      'its own deadline passed',
      new MailError('IMAP MOVE timed out after 30 seconds', COMMAND_TIMEOUT),
    ],
    ['the connection was lost under it', closedUnder()],
    [
      'imapflow answered false on a connection that is gone',
      errorOf(() =>
        requireOk(false, 'MOVE', { usable: false } as unknown as ImapConnection)
      ),
    ],
  ])('is written when %s', async (_case, error) => {
    const lines = auditLines();
    await expect(
      auditedWrite(
        'move',
        { from: 'INBOX', to: 'Archive', uids: [1] },
        async () => {
          throw error;
        }
      )
    ).rejects.toBe(error);
    const audit = lines.filter((line) => line.startsWith('imap-mcp audit'));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toContain('move');
    expect(audit[0]).toContain('outcome="unknown"');
  });

  it.each([
    [
      'the server refused it',
      new MailError('IMAP MOVE was refused', 'COMMAND_REFUSED'),
    ],
    [
      'imapflow never sent it',
      Object.assign(new Error('Connection not available'), {
        code: 'NoConnection',
        rejectedFrom: 'noSocket',
      }),
    ],
    [
      'the call was cancelled before it',
      new MailError('The client cancelled this call', CANCELLED),
    ],
    [
      'its arguments were refused',
      new ToolInputError('imap-mcp: bad arguments'),
    ],
  ])('is not written when %s', async (_case, error) => {
    const lines = auditLines();
    await expect(
      auditedWrite('move', { uids: [1] }, async () => {
        throw error;
      })
    ).rejects.toBe(error);
    expect(lines.filter((line) => line.startsWith('imap-mcp audit'))).toEqual(
      []
    );
  });

  it('writes nothing of its own for a write that went through', async () => {
    const lines = auditLines();
    await expect(
      auditedWrite('move', { uids: [1] }, async () => 'moved')
    ).resolves.toBe('moved');
    expect(lines).toEqual([]);
  });
});

describe('the hints for these outcomes', () => {
  it('tells a MAILBOX_BUSY caller that nothing was sent and trying again is safe', async () => {
    const result = await run(async () => {
      throw new MailError(
        'IMAP SELECT waited 30 seconds for another call',
        'MAILBOX_BUSY'
      );
    });
    const text = JSON.stringify(result);
    expect(text).toContain('nothing was sent');
    expect(text).toContain('safe');
  });

  it('tells a caller whose write lost its connection that it may have run', async () => {
    const result = await run(async () =>
      requireOk<never>(false, 'APPEND', {
        usable: false,
      } as unknown as ImapConnection)
    );
    expect(JSON.stringify(result)).toContain('check');
  });
});

describe('tool calls that share the connection', () => {
  it('leaves a lockless RENAME on the wire alone when a locked call is cancelled', async () => {
    const harness = await connect({
      config: { readOnly: false },
      elicit: 'accept',
    });
    const rename = held(harness.imap, { path: 'Archive', newPath: 'Old' });
    harness.imap.mailboxRename = () => rename.run() as never;
    const search = held(harness.imap, [] as number[]);
    harness.imap.search = () => search.run() as never;
    const closed = vi.spyOn(harness.imap, 'close');

    const renameArgs = {
      action: 'rename',
      mailbox: 'Archive',
      new_name: 'Old',
    };
    // A rename is confirmed with a token first; the second call performs it.
    const asked = await call(harness.client, 'manage_mailbox', renameArgs);
    const renaming = call(harness.client, 'manage_mailbox', {
      ...renameArgs,
      confirm_token: tokenOf(asked),
    });
    await rename.began;
    const controller = new AbortController();
    const listing = harness.client.callTool(
      { name: 'list_messages', arguments: {} },
      { signal: controller.signal }
    );
    await search.began;
    controller.abort();
    await expect(listing).rejects.toThrow();
    expect(closed).not.toHaveBeenCalled();

    rename.release();
    expect(jsonOf(await renaming)).toMatchObject({ action: 'rename' });
    expect(rename.count).toBe(1);
    search.release();
    await vi.waitFor(() => expect(closed).toHaveBeenCalled());
    await harness.close();
  });

  it('writes an audit line with outcome=unknown when a draft may or may not have been stored', async () => {
    const harness = await connect({
      config: {
        readOnly: false,
        imap: { ...testConfig().imap, commandTimeoutMs: 50 },
      },
    });
    harness.imap.append = () => stalledUntilClosed(harness.imap) as never;
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const result = await call(harness.client, 'save_draft', {
      to: ['anna@example.net'],
      subject: 'Re: Please review',
      body: 'Will do.',
    });
    expect(result.isError).toBe(true);
    const audit = lines.filter((line) => line.startsWith('imap-mcp audit'));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toContain('save_draft');
    expect(audit[0]).toContain('outcome="unknown"');
    await harness.close();
  });

  it('writes the usual audit line, and no other, for a draft that was stored', async () => {
    const harness = await connect({ config: { readOnly: false } });
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    await call(harness.client, 'save_draft', {
      to: ['anna@example.net'],
      subject: 'Re: Please review',
      body: 'Will do.',
    });
    const audit = lines.filter((line) => line.startsWith('imap-mcp audit'));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toContain('save_draft');
    expect(audit[0]).not.toContain('outcome=');
    await harness.close();
  });
});
