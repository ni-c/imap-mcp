import { describe, expect, it, vi } from 'vitest';

import { MailError, ToolInputError } from '../src/errors.js';
import { getEventListeners } from 'node:events';

import {
  CANCELLED,
  COMMAND_TIMEOUT,
  ImapClient,
  asMailError,
  canStoreFlag,
  collectFetch,
  downloadDeadline,
  MAX_SOURCE_BYTES,
  normalizeFlag,
  socketTimeoutFor,
  withTimeout,
} from '../src/imap.js';
import { run } from '../src/result.js';

import { FakeImap, message, stalledUntilClosed } from './fake-imap.js';
import { testConfig } from './harness.js';

function boxes() {
  return [{ path: 'INBOX', messages: [message(1)] }];
}

describe('ImapClient', () => {
  it('connects lazily and only once', async () => {
    const fake = new FakeImap(boxes());
    const client = new ImapClient(testConfig(), () => fake);
    expect(fake.connected).toBe(false);

    await client.withMailbox('INBOX', true, undefined, async () => 'a');
    await client.withMailbox('INBOX', true, undefined, async () => 'b');
    expect(fake.calls.filter((entry) => entry.name === 'connect')).toHaveLength(
      1
    );
  });

  it('refuses to connect without credentials', async () => {
    const fake = new FakeImap(boxes());
    const config = testConfig();
    config.imap.host = undefined;
    const client = new ImapClient(config, () => fake);
    await expect(
      client.withMailbox('INBOX', true, undefined, async () => 'x')
    ).rejects.toThrow(/IMAP_HOST/);
    expect(fake.connected).toBe(false);
  });

  it('opens the default mailbox when none is given', async () => {
    const fake = new FakeImap(boxes());
    const client = new ImapClient(testConfig(), () => fake);
    await client.withMailbox(
      undefined,
      true,
      undefined,
      async (_c, path) => path
    );
    expect(fake.lockLog).toEqual([{ path: 'INBOX', readOnly: true }]);
  });

  it('releases the lock when the body throws', async () => {
    const fake = new FakeImap(boxes());
    const client = new ImapClient(testConfig(), () => fake);
    await expect(
      client.withMailbox('INBOX', true, undefined, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow();
    expect(fake.openLocks).toBe(0);
  });

  it('reconnects once after a dropped connection', async () => {
    const fake = new FakeImap(boxes());
    const client = new ImapClient(testConfig(), () => fake);
    await client.withMailbox('INBOX', true, undefined, async () => 'warm');

    fake.failNext = Object.assign(new Error('socket gone'), {
      code: 'ECONNRESET',
    });
    const result = await client.withMailbox(
      'INBOX',
      true,
      undefined,
      async () => 'again'
    );
    expect(result).toBe('again');
    expect(fake.calls.filter((entry) => entry.name === 'connect')).toHaveLength(
      2
    );
  });

  it('survives an error event on an idle connection and reconnects', async () => {
    const fake = new FakeImap(boxes());
    const client = new ImapClient(testConfig(), () => fake);
    await client.withMailbox('INBOX', true, undefined, async () => 'warm');

    fake.emit(
      'error',
      Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT' })
    );
    await client.withMailbox('INBOX', true, undefined, async () => 'again');
    expect(fake.calls.filter((entry) => entry.name === 'connect')).toHaveLength(
      2
    );
  });

  it('reconnects without a failed round trip after a clean close', async () => {
    const first = new FakeImap(boxes());
    const second = new FakeImap(boxes());
    const fakes = [first, second];
    const client = new ImapClient(testConfig(), () => fakes.shift()!);
    await client.withMailbox('INBOX', true, undefined, async () => 'warm');
    const noops = first.calls.filter((entry) => entry.name === 'noop').length;

    first.close();
    const result = await client.withMailbox(
      'INBOX',
      true,
      undefined,
      async () => 'again'
    );
    expect(result).toBe('again');
    expect(first.calls.filter((entry) => entry.name === 'noop')).toHaveLength(
      noops
    );
    expect(
      second.calls.filter((entry) => entry.name === 'connect')
    ).toHaveLength(1);
  });

  it('keeps the new connection when a replaced one reports its end', async () => {
    const first = new FakeImap(boxes());
    const second = new FakeImap(boxes());
    const fakes = [first, second];
    const client = new ImapClient(testConfig(), () => fakes.shift()!);
    await client.withMailbox('INBOX', true, undefined, async () => 'warm');

    first.emit('error', new Error('read ETIMEDOUT'));
    await client.withMailbox('INBOX', true, undefined, async () => 'second');
    // Late news from the first connection, after the second took over.
    first.emit('error', new Error('read ETIMEDOUT'));
    first.emit('close');
    const result = await client.withMailbox(
      'INBOX',
      true,
      undefined,
      async () => 'still'
    );
    expect(result).toBe('still');
    expect(fakes).toHaveLength(0);
    expect(
      second.calls.filter((entry) => entry.name === 'connect')
    ).toHaveLength(1);
    expect(second.calls.filter((entry) => entry.name === 'noop')).toHaveLength(
      2
    );
  });

  it('falls back to close when a logout closes and then fails', async () => {
    const fake = new FakeImap(boxes());
    fake.logout = async () => {
      fake.close();
      throw new Error('connection closed during logout');
    };
    const closed = vi.spyOn(fake, 'close');
    const client = new ImapClient(testConfig(), () => fake);
    await client.listMailboxes(undefined);

    await expect(client.close()).resolves.toBeUndefined();
    expect(closed).toHaveBeenCalledTimes(2);
    await expect(client.close()).resolves.toBeUndefined();
  });

  it('does not retry an error that is not a connection failure', async () => {
    const fake = new FakeImap(boxes());
    const client = new ImapClient(testConfig(), () => fake);
    await client.withMailbox('INBOX', true, undefined, async () => 'warm');

    fake.failNext = Object.assign(new Error('no permission'), { code: 'NO' });
    await expect(
      client.withMailbox('INBOX', true, undefined, async () => 'again')
    ).rejects.toThrow(/no permission/);
    expect(fake.calls.filter((entry) => entry.name === 'connect')).toHaveLength(
      1
    );
  });

  it('reconnects for connection-less commands too', async () => {
    const fake = new FakeImap(boxes());
    const client = new ImapClient(testConfig(), () => fake);
    await client.listMailboxes(undefined);
    fake.failNext = Object.assign(new Error('gone'), { code: 'EPIPE' });
    await expect(client.listMailboxes(undefined)).resolves.toMatchObject({
      total: 1,
    });
  });

  it('surfaces a connect failure as a MailError', async () => {
    const client = new ImapClient(testConfig(), () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), {
        code: 'ENOTFOUND',
      });
    });
    await expect(client.listMailboxes(undefined)).rejects.toBeInstanceOf(
      MailError
    );
  });

  it('reports mailbox counters from a single LIST', async () => {
    const fake = new FakeImap([
      { path: 'INBOX', messages: [message(1), message(2)] },
    ]);
    const client = new ImapClient(testConfig(), () => fake);
    const { mailboxes } = await client.listMailboxes(undefined);
    expect(mailboxes[0]).toMatchObject({
      path: 'INBOX',
      messages: 2,
      unseen: 2,
    });
    expect(fake.calls.filter((entry) => entry.name === 'status')).toHaveLength(
      0
    );
  });

  describe('keywordSupported', () => {
    it('accepts a server that takes arbitrary keywords', () => {
      const client = new ImapClient(testConfig(), () => new FakeImap(boxes()));
      expect(client.keywordSupported(new Set(['\\Seen', '\\*']))).toBe(true);
    });

    it('accepts a server that lists the keyword explicitly', () => {
      const client = new ImapClient(testConfig(), () => new FakeImap(boxes()));
      expect(client.keywordSupported(new Set(['AiSeen']))).toBe(true);
    });

    it('rejects a server that stores neither', () => {
      const client = new ImapClient(testConfig(), () => new FakeImap(boxes()));
      expect(client.keywordSupported(new Set(['\\Seen']))).toBe(false);
    });

    it('is off when the keyword is empty, even on a permissive server', () => {
      const config = testConfig();
      config.imap.seenKeyword = '';
      const client = new ImapClient(config, () => new FakeImap(boxes()));
      expect(client.keywordSupported(new Set(['\\*']))).toBe(false);
    });
  });

  it('does not tag when the keyword is disabled', async () => {
    const fake = new FakeImap(boxes());
    const config = testConfig();
    config.imap.seenKeyword = '';
    const client = new ImapClient(config, () => fake);
    await client.tagSeen(fake, [1]);
    expect(fake.calls.some((entry) => entry.name === 'messageFlagsAdd')).toBe(
      false
    );
  });

  it('does not issue a STORE for an empty UID list', async () => {
    const fake = new FakeImap(boxes());
    const client = new ImapClient(testConfig(), () => fake);
    await client.tagSeen(fake, []);
    expect(fake.calls.some((entry) => entry.name === 'messageFlagsAdd')).toBe(
      false
    );
  });

  it('logs out on close and tolerates a failing logout', async () => {
    const fake = new FakeImap(boxes());
    const client = new ImapClient(testConfig(), () => fake);
    await client.listMailboxes(undefined);
    await client.close();
    expect(fake.connected).toBe(false);

    const rude = new FakeImap(boxes());
    rude.logout = async () => {
      throw new Error('connection already gone');
    };
    const second = new ImapClient(testConfig(), () => rude);
    await second.listMailboxes(undefined);
    await expect(second.close()).resolves.toBeUndefined();
  });

  it('treats a refused search as no matches where asked to', async () => {
    const fake = new FakeImap(boxes());
    fake.search = async () => false;
    const client = new ImapClient(testConfig(), () => fake);
    expect(await client.search(fake, { all: true }, 'empty')).toEqual([]);
  });

  it('reports a refused search as an error where the caller reports a count', async () => {
    const fake = new FakeImap(boxes());
    fake.search = async () => false;
    const client = new ImapClient(testConfig(), () => fake);
    await expect(
      client.search(fake, { subject: 'x' }, 'throw')
    ).rejects.toMatchObject({ name: 'MailError', code: 'SEARCH_REFUSED' });
  });

  it('passes an answered search through in both modes', async () => {
    const fake = new FakeImap(boxes());
    fake.search = async () => [];
    const client = new ImapClient(testConfig(), () => fake);
    expect(await client.search(fake, { all: true }, 'throw')).toEqual([]);
    expect(await client.search(fake, { all: true }, 'empty')).toEqual([]);
  });

  it('returns nothing for an empty fetch range without talking to the server', async () => {
    const fake = new FakeImap(boxes());
    const client = new ImapClient(testConfig(), () => fake);
    expect(await client.fetchSummaries(fake, [])).toEqual([]);
    expect(fake.calls.some((entry) => entry.name === 'fetch')).toBe(false);
  });
});

const connects = (fake: FakeImap) =>
  fake.calls.filter((entry) => entry.name === 'connect').length;

const closedOnce = () => {
  let thrown = false;
  return async () => {
    if (!thrown) {
      thrown = true;
      throw Object.assign(new Error('Connection not available'), {
        code: 'EConnectionClosed',
      });
    }
    return 'done';
  };
};

async function* rows() {
  yield { seq: 3, flags: new Set(['\\Seen']) } as never;
  yield { uid: 9, seq: 4 } as never;
  yield { uid: 1, seq: 1 } as never;
}

// oxlint-disable-next-line require-yield -- an empty FETCH yields nothing
async function* noRows() {}

async function* oddRows() {
  yield { uid: 1.5, seq: 1 } as never;
  yield { uid: Number.NaN, seq: 2 } as never;
  yield { uid: 2, seq: 3 } as never;
}

async function* stalledRows() {
  yield { uid: 1, seq: 1 } as never;
  await new Promise(() => undefined);
}

describe('connection hardening', () => {
  it('closes the connection on its own timeout and does not run the call again', async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeImap(boxes());
      const closed = vi.spyOn(fake, 'close');
      const client = new ImapClient(testConfig(), () => fake);
      let runs = 0;
      const pending = client.withMailbox('INBOX', true, undefined, async () => {
        runs += 1;
        return withTimeout(new Promise<never>(() => {}), 'SEARCH', 30_000);
      });
      const assertion = expect(pending).rejects.toMatchObject({
        code: COMMAND_TIMEOUT,
      });
      await vi.advanceTimersByTimeAsync(31_000);
      await assertion;
      // The command may have run on the server: closed, not repeated.
      expect(runs).toBe(1);
      expect(closed).toHaveBeenCalled();
      // And the next call does not queue behind the abandoned command.
      await client.withMailbox('INBOX', true, undefined, async () => 'next');
      expect(connects(fake)).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up on a connect that never completes', async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeImap(boxes());
      fake.connect = () => new Promise<void>(() => {});
      const closed = vi.spyOn(fake, 'close');
      const client = new ImapClient(testConfig(), () => fake);
      const pending = client.withMailbox(
        'INBOX',
        true,
        undefined,
        async () => 'x'
      );
      const assertion = expect(pending).rejects.toThrow(/CONNECT timed out/);
      await vi.advanceTimersByTimeAsync(61_000);
      await assertion;
      expect(closed).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not answer the first refused connect from memory', async () => {
    const fake = new FakeImap(boxes());
    fake.connect = async () => {
      fake.calls.push({ name: 'connect', args: [] });
      throw Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
      });
    };
    const client = new ImapClient(testConfig(), () => fake);
    const error = (await client
      .withMailbox('INBOX', true, undefined, async () => 'x')
      .catch((thrown: unknown) => thrown)) as Error;
    expect(error.message).not.toContain('repeated from memory');
    expect(connects(fake)).toBe(1);
  });

  it('reconnects when the connection died under the NOOP', async () => {
    const fake = new FakeImap(boxes());
    const original = fake.noop.bind(fake);
    let first = true;
    fake.noop = async () => {
      await original();
      if (first) {
        first = false;
        // What imapflow does when the socket is gone: the NOOP "succeeds"
        // and the selected mailbox is dropped.
        (fake as unknown as { selected: string | undefined }).selected =
          undefined;
      }
    };
    const client = new ImapClient(testConfig(), () => fake);
    await expect(
      client.withMailbox('INBOX', true, undefined, async () => 'fine')
    ).resolves.toBe('fine');
    expect(connects(fake)).toBe(2);
  });

  it('asks a read again after imapflow reports the connection closed, but not a write', async () => {
    const fake = new FakeImap(boxes());
    const client = new ImapClient(testConfig(), () => fake);
    await expect(
      client.withMailbox('INBOX', true, undefined, closedOnce())
    ).resolves.toBe('done');
    // A STORE that may have reached the server is not sent a second time.
    const add = fake.messageFlagsAdd.bind(fake);
    let stores = 0;
    fake.messageFlagsAdd = async (...args) => {
      stores += 1;
      if (stores === 1) {
        throw Object.assign(new Error('Connection not available'), {
          code: 'EConnectionClosed',
        });
      }
      return add(...args);
    };
    await expect(
      client.withMailbox('INBOX', false, undefined, (connection) =>
        connection.messageFlagsAdd([1], ['\\Flagged'], { uid: true })
      )
    ).rejects.toMatchObject({ code: 'EConnectionClosed' });
    expect(stores).toBe(1);
  });

  it('asks a write call again when none of its writes had gone out', async () => {
    const fake = new FakeImap(boxes());
    const client = new ImapClient(testConfig(), () => fake);
    await expect(
      client.withMailbox('INBOX', false, undefined, closedOnce())
    ).resolves.toBe('done');
  });

  it('counts a STATUS the server refused as omitted', async () => {
    const fake = new FakeImap(boxes());
    fake.capabilities.delete('LIST-STATUS');
    fake.status = async () => false;
    const client = new ImapClient(testConfig(), () => fake);
    const listing = await client.listMailboxes(undefined);
    expect(listing.statusOmitted).toBe(1);
    expect(listing.mailboxes[0]?.messages).toBeUndefined();
  });

  it('treats a search without a selected mailbox as a lost connection', async () => {
    const fake = new FakeImap(boxes());
    fake.search = async () => undefined;
    const client = new ImapClient(testConfig(), () => fake);
    await expect(
      client.search(fake, { all: true }, 'empty')
    ).rejects.toMatchObject({ code: 'NoConnection' });
  });

  it('keeps only the FETCH rows that were asked for', async () => {
    const found = await collectFetch(rows(), [1], 30_000);
    expect(found.map((row) => row.uid)).toEqual([1]);
  });

  it('keeps nothing when nothing was asked for, or nothing came', async () => {
    expect(await collectFetch(rows(), [], 30_000)).toEqual([]);
    expect(await collectFetch(noRows(), [1, 2], 30_000)).toEqual([]);
  });

  it('drops a row whose UID is not a whole number', async () => {
    const found = await collectFetch(oddRows(), [1, 2], 30_000);
    expect(found.map((row) => row.uid)).toEqual([2]);
  });

  it('gives up on a FETCH that never ends', async () => {
    vi.useFakeTimers();
    try {
      const pending = collectFetch(stalledRows(), [1], 30_000);
      const settled = expect(pending).rejects.toMatchObject({
        code: COMMAND_TIMEOUT,
      });
      await vi.advanceTimersByTimeAsync(31_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for a connect in flight before closing', async () => {
    const fake = new FakeImap(boxes());
    const logout = vi.spyOn(fake, 'logout');
    const client = new ImapClient(testConfig(), () => fake);
    const call = client.withMailbox('INBOX', true, undefined, async () => 'x');
    await client.close();
    await call.catch(() => undefined);
    await client.close();
    expect(logout).toHaveBeenCalled();
  });
});

describe('the errors imapflow really throws', () => {
  it('turns a refused LOGIN into the credentials hint', async () => {
    // imapflow leaves `code` unset and says it in these two fields.
    const refused = Object.assign(new Error('Command failed'), {
      responseStatus: 'NO',
      serverResponseCode: 'AUTHENTICATIONFAILED',
      authenticationFailed: true,
      responseText: 'Invalid credentials',
    });
    expect(asMailError(refused).code).toBe('AUTHENTICATIONFAILED');
    const result = await run(async () => {
      throw asMailError(refused);
    });
    const text = JSON.stringify(result);
    expect(text).toContain('IMAP_USER and IMAP_PASSWORD');
  });

  it.each([
    'GREETING_TIMEOUT',
    'CONNECT_TIMEOUT',
    'ERR_SSL_WRONG_VERSION_NUMBER',
  ])('turns %s into the TLS hint', async (code) => {
    const result = await run(async () => {
      throw asMailError(Object.assign(new Error('x'), { code }));
    });
    expect(JSON.stringify(result)).toContain('IMAP_TLS');
  });

  it('takes the server response code when imapflow gives no code', () => {
    const quota = Object.assign(new Error('Command failed'), {
      serverResponseCode: 'OVERQUOTA',
    });
    expect(asMailError(quota).code).toBe('OVERQUOTA');
  });
});

describe('withTimeout', () => {
  it('passes a value through', async () => {
    await expect(withTimeout(Promise.resolve(7), 'NOOP', 50)).resolves.toBe(7);
  });

  it('rejects with a MailError once the deadline passes', async () => {
    vi.useFakeTimers();
    const pending = withTimeout(new Promise(() => {}), 'SEARCH', 50);
    const assertion = expect(pending).rejects.toThrow(/SEARCH timed out/);
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
    vi.useRealTimers();
  });

  it('clears the timer when the command wins', async () => {
    vi.useFakeTimers();
    await expect(withTimeout(Promise.resolve('ok'), 'NOOP', 50)).resolves.toBe(
      'ok'
    );
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});

describe('asMailError', () => {
  it('passes an existing MailError through untouched', () => {
    const original = new MailError('already wrapped');
    expect(asMailError(original)).toBe(original);
  });

  it('rethrows a ToolInputError rather than disguising it as a server fault', () => {
    expect(() => asMailError(new ToolInputError('bad uid'))).toThrow(
      ToolInputError
    );
  });

  it('keeps the code and the response text', () => {
    const error = asMailError(
      Object.assign(new Error('login failed'), {
        code: 'AUTHENTICATIONFAILED',
        responseText: 'NO [AUTHENTICATIONFAILED] Invalid credentials',
      })
    );
    expect(error.code).toBe('AUTHENTICATIONFAILED');
    expect(error.responseText).toContain('Invalid credentials');
    expect(error.message).toContain('IMAP error');
  });

  it('does not carry the sent command — that is where the password would be', () => {
    const error = asMailError(
      Object.assign(new Error('command failed'), {
        code: 'BAD',
        command: 'A1 LOGIN me@example.net hunter2',
        responseText: 'BAD syntax error',
      })
    );
    expect(JSON.stringify(error)).not.toContain('hunter2');
    expect(error.responseText).toBe('BAD syntax error');
  });

  it('handles a thrown non-Error', () => {
    expect(asMailError('just a string').message).toContain('just a string');
  });
});

describe('canStoreFlag', () => {
  it('allows everything when the server sent no list', () => {
    expect(canStoreFlag(undefined, 'Project')).toBe(true);
    expect(canStoreFlag(false, '\\Draft')).toBe(true);
  });

  it('allows nothing on an empty list', () => {
    expect(canStoreFlag(new Set(), '\\Seen')).toBe(false);
    expect(canStoreFlag(new Set(), 'Project')).toBe(false);
  });

  it('allows any flag under \\*', () => {
    expect(canStoreFlag(new Set(['\\*']), 'Project')).toBe(true);
    expect(canStoreFlag(new Set(['\\*']), '\\Draft')).toBe(true);
  });

  it('matches a listed keyword exactly and refuses an unlisted one', () => {
    const listed = new Set(['\\Seen', 'Project']);
    expect(canStoreFlag(listed, 'Project')).toBe(true);
    expect(canStoreFlag(listed, 'Other')).toBe(false);
  });

  it('compares system flags case-insensitively, keywords as written', () => {
    const listed = new Set(['\\Seen', 'Project']);
    expect(canStoreFlag(listed, '\\seen')).toBe(true);
    expect(canStoreFlag(listed, '\\SEEN')).toBe(true);
    expect(canStoreFlag(listed, 'project')).toBe(false);
  });
});

describe('normalizeFlag', () => {
  it('spells system flags the way imapflow sends them', () => {
    expect(normalizeFlag('\\draft')).toBe('\\Draft');
    expect(normalizeFlag('\\ANSWERED')).toBe('\\Answered');
  });

  it('leaves keywords and unknown backslash flags alone', () => {
    expect(normalizeFlag('$Label1')).toBe('$Label1');
    expect(normalizeFlag('\\Recent')).toBe('\\Recent');
    expect(normalizeFlag('')).toBe('');
  });
});

/** Resolves with a flag that turns true once `promise` settles either way. */
function watch(promise: Promise<unknown>): { settled: boolean } {
  const state = { settled: false };
  promise.then(
    () => (state.settled = true),
    () => (state.settled = true)
  );
  return state;
}

describe('the configured command timeout', () => {
  it('ends a SEARCH at the configured deadline, closed and not repeated', async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeImap(boxes());
      fake.search = () => new Promise<never>(() => {});
      const closed = vi.spyOn(fake, 'close');
      const config = testConfig();
      config.imap.commandTimeoutMs = 45_000;
      const client = new ImapClient(config, () => fake);
      let runs = 0;
      const pending = client.withMailbox(
        'INBOX',
        true,
        undefined,
        async (connection) => {
          runs += 1;
          return client.search(connection, { all: true }, 'throw');
        }
      );
      const state = watch(pending);
      await vi.advanceTimersByTimeAsync(44_000);
      expect(state.settled).toBe(false);
      const assertion = expect(pending).rejects.toMatchObject({
        code: COMMAND_TIMEOUT,
        message: 'IMAP SEARCH timed out after 45 seconds',
      });
      await vi.advanceTimersByTimeAsync(2_000);
      await assertion;
      expect(runs).toBe(1);
      expect(closed).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up on a FETCH at the deadline it is handed', async () => {
    vi.useFakeTimers();
    try {
      const pending = collectFetch(stalledRows(), [1], 5_000);
      const state = watch(pending);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(state.settled).toBe(false);
      const assertion = expect(pending).rejects.toMatchObject({
        code: COMMAND_TIMEOUT,
      });
      await vi.advanceTimersByTimeAsync(2);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds the reply lookup of a draft, which had no deadline of its own', async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeImap(boxes());
      fake.fetch = () => stalledRows() as never;
      const config = testConfig();
      config.imap.commandTimeoutMs = 2_000;
      const client = new ImapClient(config, () => fake);
      const pending = client.threadHeaders('INBOX', 1, undefined);
      const assertion = expect(pending).rejects.toMatchObject({
        code: COMMAND_TIMEOUT,
        message: 'IMAP FETCH timed out after 2 seconds',
      });
      await vi.advanceTimersByTimeAsync(2_001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('names a deadline of one second in the singular', async () => {
    vi.useFakeTimers();
    try {
      const pending = withTimeout(
        new Promise<never>(() => {}),
        'SEARCH',
        1_000
      );
      const assertion = expect(pending).rejects.toMatchObject({
        message: 'IMAP SEARCH timed out after 1 second',
      });
      await vi.advanceTimersByTimeAsync(1_001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('carries the code it is handed, and COMMAND_TIMEOUT otherwise', async () => {
    vi.useFakeTimers();
    try {
      const own = withTimeout(
        new Promise<never>(() => {}),
        'CONNECT',
        50,
        'CONNECT_TIMEOUT'
      );
      const plain = withTimeout(new Promise<never>(() => {}), 'NOOP', 50);
      const first = expect(own).rejects.toMatchObject({
        code: 'CONNECT_TIMEOUT',
      });
      const second = expect(plain).rejects.toMatchObject({
        code: COMMAND_TIMEOUT,
      });
      await vi.advanceTimersByTimeAsync(60);
      await first;
      await second;
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds a deadline longer than a timer can, instead of firing at once', async () => {
    // Node fires a timer past 2^31 - 1 ms after one millisecond. A download
    // cap of a few terabytes asks for a deadline that long.
    let release!: (value: string) => void;
    const pending = withTimeout(
      new Promise<string>((resolve) => {
        release = resolve;
      }),
      'FETCH',
      2 ** 40
    );
    const state = watch(pending);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state.settled).toBe(false);
    release('done');
    await expect(pending).resolves.toBe('done');
  });

  it.each([1_000, 600_000])(
    'keeps the connect deadline at 60 seconds next to a %i ms command timeout',
    async (commandTimeoutMs) => {
      vi.useFakeTimers();
      try {
        const fake = new FakeImap(boxes());
        let attempts = 0;
        fake.connect = () => {
          attempts += 1;
          return new Promise<void>(() => {});
        };
        const config = testConfig();
        config.imap.commandTimeoutMs = commandTimeoutMs;
        const client = new ImapClient(config, () => fake);
        const pending = client.withMailbox(
          'INBOX',
          true,
          undefined,
          async () => 'x'
        );
        const state = watch(pending);
        await vi.advanceTimersByTimeAsync(59_000);
        expect(state.settled).toBe(false);
        const assertion = expect(pending).rejects.toMatchObject({
          code: 'CONNECT_TIMEOUT',
          message: 'IMAP CONNECT timed out after 60 seconds',
        });
        await vi.advanceTimersByTimeAsync(2_000);
        await assertion;
        // Not repeated within the call, and answered from memory right after.
        expect(attempts).toBe(1);
        const again = client.withMailbox(
          'INBOX',
          true,
          undefined,
          async () => 'x'
        );
        await expect(again).rejects.toMatchObject({ code: 'CONNECT_TIMEOUT' });
        await expect(again).rejects.toThrow(/repeated from memory/);
        expect(attempts).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it("gives its own connect deadline the host and TLS hint, not the command timeout's", async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeImap(boxes());
      fake.connect = () => new Promise<void>(() => {});
      const client = new ImapClient(testConfig(), () => fake);
      const result = run(async () => {
        await client.withMailbox('INBOX', true, undefined, async () => 'x');
        return { content: [] };
      });
      await vi.advanceTimersByTimeAsync(61_000);
      const text = JSON.stringify(await result);
      expect(text).toContain('IMAP_TLS');
      expect(text).not.toContain('IMAP_COMMAND_TIMEOUT_SECONDS');
    } finally {
      vi.useRealTimers();
    }
  });

  it('points a command timeout at IMAP_COMMAND_TIMEOUT_SECONDS', async () => {
    const result = await run(async () => {
      throw new MailError(
        'IMAP SEARCH timed out after 30 seconds',
        COMMAND_TIMEOUT
      );
    });
    const text = JSON.stringify(result);
    expect(text).toContain('IMAP_COMMAND_TIMEOUT_SECONDS');
    expect(text).toContain('check the state');
    expect(text).not.toContain('IMAP_TLS');
  });

  it.each(['CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'ETIMEDOUT'])(
    'never suggests the command timeout for %s',
    async (code) => {
      const result = await run(async () => {
        throw asMailError(Object.assign(new Error('x'), { code }));
      });
      expect(JSON.stringify(result)).not.toContain(
        'IMAP_COMMAND_TIMEOUT_SECONDS'
      );
    }
  );
});

function idleFor(
  commandTimeoutMs: number,
  overrides: { maxDownloadBytes?: number } = {}
): number {
  const config = testConfig();
  Object.assign(config.imap, { commandTimeoutMs, ...overrides });
  return socketTimeoutFor(config.imap);
}

describe('the idle timer handed to imapflow', () => {
  it("stays at imapflow's five minutes for the defaults", () => {
    expect(idleFor(30_000)).toBe(300_000);
  });

  it('grows past the longest deadline this server sets', () => {
    // The 25 MiB download cap gives a deadline of T + 250 s; 10 s on top.
    expect(idleFor(40_000)).toBe(300_000);
    expect(idleFor(41_000)).toBe(301_000);
    expect(idleFor(600_000)).toBe(860_000);
  });

  it.each([1_000, 30_000, 299_000, 600_000])(
    'outlasts a %i ms command timeout and the largest download',
    (commandTimeoutMs) => {
      const config = testConfig();
      config.imap.commandTimeoutMs = commandTimeoutMs;
      const largest = Math.max(
        config.imap.maxAttachmentBytes,
        config.imap.maxDownloadBytes,
        config.imap.maxExtractBytes
      );
      const idle = socketTimeoutFor(config.imap);
      expect(idle).toBeGreaterThan(commandTimeoutMs);
      expect(idle).toBeGreaterThan(downloadDeadline(largest, commandTimeoutMs));
    }
  );

  it('outlasts the get_message fetch when every byte limit is smaller', () => {
    const config = testConfig();
    Object.assign(config.imap, {
      commandTimeoutMs: 600_000,
      maxAttachmentBytes: 1024 * 1024,
      maxDownloadBytes: 1024 * 1024,
      maxExtractBytes: 1024 * 1024,
    });
    expect(socketTimeoutFor(config.imap)).toBeGreaterThan(
      downloadDeadline(MAX_SOURCE_BYTES, 600_000)
    );
  });

  it('never asks for more than a timer can hold', () => {
    expect(idleFor(30_000, { maxDownloadBytes: 2 ** 40 })).toBe(2 ** 31 - 1);
  });
});

describe('a call the client cancels', () => {
  it('closes the connection under a running command and is not repeated', async () => {
    const fake = new FakeImap(boxes());
    let searching!: () => void;
    const started = new Promise<void>((resolve) => {
      searching = resolve;
    });
    fake.search = () => {
      searching();
      return stalledUntilClosed(fake);
    };
    const closed = vi.spyOn(fake, 'close');
    const client = new ImapClient(testConfig(), () => fake);
    const controller = new AbortController();
    let runs = 0;
    const pending = client.withMailbox(
      'INBOX',
      true,
      controller.signal,
      async (connection) => {
        runs += 1;
        return client.search(connection, { all: true }, 'throw');
      }
    );
    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: CANCELLED });
    expect(runs).toBe(1);
    expect(closed).toHaveBeenCalled();
    // The next call gets a fresh connection instead of queueing behind it.
    await expect(
      client.withMailbox('INBOX', true, undefined, async () => 'next')
    ).resolves.toBe('next');
    expect(connects(fake)).toBe(2);
  });

  it('does not connect at all once it is already cancelled', async () => {
    const fake = new FakeImap(boxes());
    const client = new ImapClient(testConfig(), () => fake);
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.withMailbox('INBOX', true, controller.signal, async () => 'x')
    ).rejects.toMatchObject({ code: CANCELLED });
    await expect(client.listMailboxes(controller.signal)).rejects.toMatchObject(
      { code: CANCELLED }
    );
    expect(connects(fake)).toBe(0);
  });

  it('stops waiting for a connect without ending it for another caller', async () => {
    const fake = new FakeImap(boxes());
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    fake.connect = async () => {
      fake.calls.push({ name: 'connect', args: [] });
      await gate;
      fake.connected = true;
    };
    const client = new ImapClient(testConfig(), () => fake);
    const controller = new AbortController();
    const cancelled = client.withMailbox(
      'INBOX',
      true,
      controller.signal,
      async () => 'a'
    );
    const other = client.withMailbox('INBOX', true, undefined, async () => 'b');
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: CANCELLED });
    open();
    await expect(other).resolves.toBe('b');
    expect(connects(fake)).toBe(1);
    // Nothing was refused, so the next call is not answered from memory.
    await expect(
      client.withMailbox('INBOX', true, undefined, async () => 'c')
    ).resolves.toBe('c');
  });

  it('leaves the call it is queued behind alone and hands the lock back', async () => {
    const fake = new FakeImap(boxes());
    const lock = fake.getMailboxLock.bind(fake);
    let grant!: () => void;
    let requested = 0;
    fake.getMailboxLock = async (path, options) => {
      requested += 1;
      if (requested === 2) {
        await new Promise<void>((resolve) => {
          grant = resolve;
        });
      }
      return lock(path, options);
    };
    const closed = vi.spyOn(fake, 'close');
    const client = new ImapClient(testConfig(), () => fake);
    let finishFirst: (() => void) | undefined;
    const first = client.withMailbox(
      'INBOX',
      true,
      undefined,
      () =>
        new Promise<string>((resolve) => {
          finishFirst = () => resolve('first');
        })
    );
    await vi.waitFor(() => expect(finishFirst).toBeDefined());
    const controller = new AbortController();
    const queued = client.withMailbox(
      'INBOX',
      true,
      controller.signal,
      async () => 'second'
    );
    await vi.waitFor(() => expect(requested).toBe(2));
    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: CANCELLED });
    expect(closed).not.toHaveBeenCalled();
    finishFirst?.();
    await expect(first).resolves.toBe('first');
    grant();
    // Granted after the caller left: taken and released at once, not leaked.
    await vi.waitFor(() => {
      expect(fake.lockLog).toHaveLength(2);
      expect(fake.openLocks).toBe(0);
    });
  });

  it('closes the connection under a running listing', async () => {
    const fake = new FakeImap(boxes());
    let listing!: () => void;
    const started = new Promise<void>((resolve) => {
      listing = resolve;
    });
    fake.list = () => {
      listing();
      return stalledUntilClosed(fake);
    };
    const closed = vi.spyOn(fake, 'close');
    const client = new ImapClient(testConfig(), () => fake);
    const controller = new AbortController();
    const pending = client.listMailboxes(controller.signal);
    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: CANCELLED });
    expect(closed).toHaveBeenCalled();
  });

  it('leaves no abort listener and no timer behind once it has answered', async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeImap(boxes());
      const client = new ImapClient(testConfig(), () => fake);
      const controller = new AbortController();
      await client.withMailbox(
        'INBOX',
        true,
        controller.signal,
        async (connection) => client.search(connection, { all: true }, 'throw')
      );
      await client.listMailboxes(controller.signal);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// The fallback has a budget of its own (STATUS_BUDGET_MS, 20 s). A command
// timeout raised past it must not stretch the listing: each STATUS gets what
// is left of the budget, or the command timeout if that is shorter.
function statusFixture(answer: (calls: number) => Promise<never | false>) {
  const fake = new FakeImap([
    { path: 'INBOX', messages: [message(1)] },
    { path: 'Archive', messages: [] },
    { path: 'Sent', messages: [] },
  ]);
  fake.capabilities.delete('LIST-STATUS');
  let statuses = 0;
  fake.status = () => {
    statuses += 1;
    return answer(statuses);
  };
  return { fake, statuses: () => statuses };
}

describe('a STATUS past its deadline', () => {
  it.each([
    [60_000, 20_000],
    [600_000, 20_000],
    [20_001, 20_000],
  ])(
    'with a %i ms command timeout gives up at the %i ms budget',
    async (commandTimeoutMs, budget) => {
      vi.useFakeTimers();
      try {
        const { fake, statuses } = statusFixture(
          () => new Promise<never>(() => {})
        );
        const config = testConfig();
        config.imap.commandTimeoutMs = commandTimeoutMs;
        const client = new ImapClient(config, () => fake);
        let omitted: number | undefined;
        void client.listMailboxes(undefined).then((listing) => {
          omitted = listing.statusOmitted;
        });
        await vi.advanceTimersByTimeAsync(budget - 1);
        expect(omitted).toBeUndefined();
        await vi.advanceTimersByTimeAsync(2);
        expect(statuses()).toBe(1);
        expect(omitted).toBe(3);
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it('gives a later STATUS only what is left of the budget', async () => {
    vi.useFakeTimers();
    try {
      // The first STATUS is refused after 15 s, the second never answers: it
      // gets the remaining 5 s, not another 30.
      const { fake, statuses } = statusFixture((calls) =>
        calls === 1
          ? new Promise<false>((resolve) => {
              setTimeout(() => resolve(false), 15_000);
            })
          : new Promise<never>(() => {})
      );
      const client = new ImapClient(testConfig(), () => fake);
      let omitted: number | undefined;
      void client.listMailboxes(undefined).then((listing) => {
        omitted = listing.statusOmitted;
      });
      await vi.advanceTimersByTimeAsync(19_999);
      expect(omitted).toBeUndefined();
      await vi.advanceTimersByTimeAsync(2);
      expect(statuses()).toBe(2);
      expect(omitted).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a command timeout shorter than the budget', async () => {
    vi.useFakeTimers();
    try {
      const { fake } = statusFixture(() => new Promise<never>(() => {}));
      const config = testConfig();
      config.imap.commandTimeoutMs = 5_000;
      const client = new ImapClient(config, () => fake);
      let omitted: number | undefined;
      void client.listMailboxes(undefined).then((listing) => {
        omitted = listing.statusOmitted;
      });
      await vi.advanceTimersByTimeAsync(5_001);
      expect(omitted).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends the STATUS fallback and closes the connection after the listing', async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeImap([
        { path: 'INBOX', messages: [message(1)] },
        { path: 'Archive', messages: [] },
        { path: 'Sent', messages: [] },
      ]);
      fake.capabilities.delete('LIST-STATUS');
      let statuses = 0;
      fake.status = () => {
        statuses += 1;
        return new Promise<never>(() => {});
      };
      const closed = vi.spyOn(fake, 'close');
      const config = testConfig();
      config.imap.commandTimeoutMs = 1_000;
      const client = new ImapClient(config, () => fake);
      let omitted: number | undefined;
      void client.listMailboxes(undefined).then((listing) => {
        omitted = listing.statusOmitted;
      });
      await vi.advanceTimersByTimeAsync(1_001);
      // The stuck STATUS is still queued, so nothing is asked behind it.
      expect(statuses).toBe(1);
      expect(omitted).toBe(3);
      expect(closed).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
