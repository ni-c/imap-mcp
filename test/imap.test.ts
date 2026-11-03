import { describe, expect, it, vi } from 'vitest';

import { MailError, ToolInputError } from '../src/errors.js';
import {
  COMMAND_TIMEOUT,
  ImapClient,
  asMailError,
  canStoreFlag,
  collectFetch,
  normalizeFlag,
  withTimeout,
} from '../src/imap.js';
import { run } from '../src/result.js';

import { FakeImap, message } from './fake-imap.js';
import { testConfig } from './harness.js';

function boxes() {
  return [{ path: 'INBOX', messages: [message(1)] }];
}

describe('ImapClient', () => {
  it('connects lazily and only once', async () => {
    const fake = new FakeImap(boxes());
    const client = new ImapClient(testConfig(), () => fake);
    expect(fake.connected).toBe(false);

    await client.withMailbox('INBOX', true, async () => 'a');
    await client.withMailbox('INBOX', true, async () => 'b');
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
      client.withMailbox('INBOX', true, async () => 'x')
    ).rejects.toThrow(/IMAP_HOST/);
    expect(fake.connected).toBe(false);
  });

  it('opens the default mailbox when none is given', async () => {
    const fake = new FakeImap(boxes());
    const client = new ImapClient(testConfig(), () => fake);
    await client.withMailbox(undefined, true, async (_c, path) => path);
    expect(fake.lockLog).toEqual([{ path: 'INBOX', readOnly: true }]);
  });

  it('releases the lock when the body throws', async () => {
    const fake = new FakeImap(boxes());
    const client = new ImapClient(testConfig(), () => fake);
    await expect(
      client.withMailbox('INBOX', true, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow();
    expect(fake.openLocks).toBe(0);
  });

  it('reconnects once after a dropped connection', async () => {
    const fake = new FakeImap(boxes());
    const client = new ImapClient(testConfig(), () => fake);
    await client.withMailbox('INBOX', true, async () => 'warm');

    fake.failNext = Object.assign(new Error('socket gone'), {
      code: 'ECONNRESET',
    });
    const result = await client.withMailbox('INBOX', true, async () => 'again');
    expect(result).toBe('again');
    expect(fake.calls.filter((entry) => entry.name === 'connect')).toHaveLength(
      2
    );
  });

  it('survives an error event on an idle connection and reconnects', async () => {
    const fake = new FakeImap(boxes());
    const client = new ImapClient(testConfig(), () => fake);
    await client.withMailbox('INBOX', true, async () => 'warm');

    fake.emit(
      'error',
      Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT' })
    );
    await client.withMailbox('INBOX', true, async () => 'again');
    expect(fake.calls.filter((entry) => entry.name === 'connect')).toHaveLength(
      2
    );
  });

  it('reconnects without a failed round trip after a clean close', async () => {
    const first = new FakeImap(boxes());
    const second = new FakeImap(boxes());
    const fakes = [first, second];
    const client = new ImapClient(testConfig(), () => fakes.shift()!);
    await client.withMailbox('INBOX', true, async () => 'warm');
    const noops = first.calls.filter((entry) => entry.name === 'noop').length;

    first.close();
    const result = await client.withMailbox('INBOX', true, async () => 'again');
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
    await client.withMailbox('INBOX', true, async () => 'warm');

    first.emit('error', new Error('read ETIMEDOUT'));
    await client.withMailbox('INBOX', true, async () => 'second');
    // Late news from the first connection, after the second took over.
    first.emit('error', new Error('read ETIMEDOUT'));
    first.emit('close');
    const result = await client.withMailbox('INBOX', true, async () => 'still');
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
    await client.listMailboxes();

    await expect(client.close()).resolves.toBeUndefined();
    expect(closed).toHaveBeenCalledTimes(2);
    await expect(client.close()).resolves.toBeUndefined();
  });

  it('does not retry an error that is not a connection failure', async () => {
    const fake = new FakeImap(boxes());
    const client = new ImapClient(testConfig(), () => fake);
    await client.withMailbox('INBOX', true, async () => 'warm');

    fake.failNext = Object.assign(new Error('no permission'), { code: 'NO' });
    await expect(
      client.withMailbox('INBOX', true, async () => 'again')
    ).rejects.toThrow(/no permission/);
    expect(fake.calls.filter((entry) => entry.name === 'connect')).toHaveLength(
      1
    );
  });

  it('reconnects for connection-less commands too', async () => {
    const fake = new FakeImap(boxes());
    const client = new ImapClient(testConfig(), () => fake);
    await client.listMailboxes();
    fake.failNext = Object.assign(new Error('gone'), { code: 'EPIPE' });
    await expect(client.listMailboxes()).resolves.toMatchObject({ total: 1 });
  });

  it('surfaces a connect failure as a MailError', async () => {
    const client = new ImapClient(testConfig(), () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), {
        code: 'ENOTFOUND',
      });
    });
    await expect(client.listMailboxes()).rejects.toBeInstanceOf(MailError);
  });

  it('reports mailbox counters from a single LIST', async () => {
    const fake = new FakeImap([
      { path: 'INBOX', messages: [message(1), message(2)] },
    ]);
    const client = new ImapClient(testConfig(), () => fake);
    const { mailboxes } = await client.listMailboxes();
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
    await client.listMailboxes();
    await client.close();
    expect(fake.connected).toBe(false);

    const rude = new FakeImap(boxes());
    rude.logout = async () => {
      throw new Error('connection already gone');
    };
    const second = new ImapClient(testConfig(), () => rude);
    await second.listMailboxes();
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
      const pending = client.withMailbox('INBOX', true, async () => {
        runs += 1;
        return withTimeout(new Promise<never>(() => {}), 'SEARCH');
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
      await client.withMailbox('INBOX', true, async () => 'next');
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
      const pending = client.withMailbox('INBOX', true, async () => 'x');
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
      .withMailbox('INBOX', true, async () => 'x')
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
      client.withMailbox('INBOX', true, async () => 'fine')
    ).resolves.toBe('fine');
    expect(connects(fake)).toBe(2);
  });

  it('asks a read again after imapflow reports the connection closed, but not a write', async () => {
    const fake = new FakeImap(boxes());
    const client = new ImapClient(testConfig(), () => fake);
    await expect(client.withMailbox('INBOX', true, closedOnce())).resolves.toBe(
      'done'
    );
    await expect(
      client.withMailbox('INBOX', false, closedOnce())
    ).rejects.toMatchObject({ code: 'EConnectionClosed' });
  });

  it('counts a STATUS the server refused as omitted', async () => {
    const fake = new FakeImap(boxes());
    fake.capabilities.delete('LIST-STATUS');
    fake.status = async () => false;
    const client = new ImapClient(testConfig(), () => fake);
    const listing = await client.listMailboxes();
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
    const found = await collectFetch(rows(), [1]);
    expect(found.map((row) => row.uid)).toEqual([1]);
  });

  it('keeps nothing when nothing was asked for, or nothing came', async () => {
    expect(await collectFetch(rows(), [])).toEqual([]);
    expect(await collectFetch(noRows(), [1, 2])).toEqual([]);
  });

  it('drops a row whose UID is not a whole number', async () => {
    const found = await collectFetch(oddRows(), [1, 2]);
    expect(found.map((row) => row.uid)).toEqual([2]);
  });

  it('gives up on a FETCH that never ends', async () => {
    vi.useFakeTimers();
    try {
      const pending = collectFetch(stalledRows(), [1]);
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
    const call = client.withMailbox('INBOX', true, async () => 'x');
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
    await expect(withTimeout(Promise.resolve(7), 'NOOP')).resolves.toBe(7);
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
