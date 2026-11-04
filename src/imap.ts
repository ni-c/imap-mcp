import { ImapFlow } from 'imapflow';
import type {
  CopyResponseObject,
  FetchMessageObject,
  FetchQueryObject,
  ListResponse,
  SearchObject,
  StatusObject,
} from 'imapflow';

import {
  missingConfigKeys,
  missingConfigMessage,
  type Config,
  type ImapConfig,
} from './config.js';
import { MailError, ToolInputError } from './errors.js';
import { isMessageId } from './message.js';

/**
 * Everything this server needs from an IMAP connection.
 *
 * Narrowing imapflow to an interface is what makes the tools testable: the unit
 * tests inject a fake through {@link ImapClientFactory} instead of standing up a
 * real server, and the surface stays small enough that the fake cannot silently
 * drift away from the real thing.
 */
const SYSTEM_FLAGS = [
  '\\Seen',
  '\\Answered',
  '\\Flagged',
  '\\Deleted',
  '\\Draft',
];

/** Spells a system flag the way imapflow sends it (`\\seen` becomes `\\Seen`). */
export function normalizeFlag(flag: string): string {
  const lower = flag.toLowerCase();
  return SYSTEM_FLAGS.find((system) => system.toLowerCase() === lower) ?? flag;
}

/**
 * Whether a flag survives imapflow's `canUseFlag()`, which APPEND and STORE
 * run against the *selected* mailbox: a flag missing from PERMANENTFLAGS is
 * dropped without an error, and the command then reports success. No list at
 * all means every flag is allowed; `\\*` allows any keyword.
 */
export function canStoreFlag(
  permanentFlags: Set<string> | false | undefined,
  flag: string
): boolean {
  if (!permanentFlags || permanentFlags.has('\\*')) return true;
  return permanentFlags.has(normalizeFlag(flag));
}

export interface ImapConnection {
  /** imapflow's own flag; false once the connection is gone. */
  readonly usable: boolean;
  connect(): Promise<void>;
  logout(): Promise<void>;
  close(): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  noop(): Promise<void>;
  list(options?: {
    statusQuery?: { messages?: boolean; unseen?: boolean; uidNext?: boolean };
  }): Promise<ListResponse[]>;
  status(
    path: string,
    query: Record<string, boolean>
  ): Promise<StatusObject | false>;
  getMailboxLock(
    path: string,
    options?: { readOnly?: boolean }
  ): Promise<{ path: string; release(): void }>;
  search(
    query: SearchObject,
    options?: { uid?: boolean }
  ): Promise<number[] | false | undefined>;
  fetch(
    range: number[] | string,
    query: FetchQueryObject,
    options?: { uid?: boolean }
  ): AsyncIterableIterator<FetchMessageObject>;
  download(
    range: string,
    part?: string,
    options?: { uid?: boolean; maxBytes?: number }
  ): Promise<{
    meta: { contentType: string; charset?: string; filename?: string };
    content: NodeJS.ReadableStream;
  }>;
  messageFlagsAdd(
    range: number[],
    flags: string[],
    options?: { uid?: boolean }
  ): Promise<boolean>;
  messageFlagsRemove(
    range: number[],
    flags: string[],
    options?: { uid?: boolean }
  ): Promise<boolean>;
  // imapflow answers a NO or BAD to a write command with `false` instead of
  // throwing. See requireOk: the result of every one of these has to be read.
  messageMove(
    range: number[],
    destination: string,
    options?: { uid?: boolean }
  ): Promise<CopyResponseObject | false>;
  messageCopy(
    range: number[],
    destination: string,
    options?: { uid?: boolean }
  ): Promise<CopyResponseObject | false>;
  messageDelete(range: number[], options?: { uid?: boolean }): Promise<boolean>;
  append(
    path: string,
    content: string | Buffer,
    flags?: string[],
    date?: Date
  ): Promise<unknown>;
  /** `created: false` is imapflow's reading of ALREADYEXISTS. */
  mailboxCreate(path: string): Promise<{ path: string; created: boolean }>;
  mailboxRename(path: string, newPath: string): Promise<unknown>;
  mailboxDelete(path: string): Promise<unknown>;
  readonly capabilities: Map<string, boolean | number>;
  /**
   * imapflow leaves `permanentFlags` unset when the server sends no
   * PERMANENTFLAGS, and RFC 9051 reads that as "all flags can be stored".
   */
  readonly mailbox:
    false | { path: string; permanentFlags?: Set<string> | false };
}

export type ImapClientFactory = (config: ImapConfig) => ImapConnection;

const defaultFactory: ImapClientFactory = (config) =>
  new ImapFlow({
    host: config.host ?? '',
    port: config.port,
    secure: config.tls === 'implicit',
    // Left unset, imapflow upgrades opportunistically — which means a
    // downgrade attack succeeds silently. Both non-implicit modes say
    // explicitly which one they meant.
    doSTARTTLS: config.tls === 'starttls',
    auth: { user: config.user ?? '', pass: config.password ?? '' },
    // The library logs full IMAP traffic — message bodies included — to stdout
    // by default. stdout is the MCP transport, so this is not optional.
    logger: false,
    // Scoped to this connection: NODE_TLS_REJECT_UNAUTHORIZED would disable
    // certificate checking for the whole process, SMTP included.
    tls: config.insecureTls ? { rejectUnauthorized: false } : {},
    // imapflow's own defaults are 1 GiB per literal and per line, and every
    // size check here runs only after imapflow has buffered the bytes — so a
    // hostile server, or anyone in the path of IMAP_TLS=none, could answer the
    // 2 MiB partial fetch of get_message with a gigabyte.
    ...IMAP_RESPONSE_LIMITS,
    socketTimeout: socketTimeoutFor(config),
  }) as unknown as ImapConnection;

/** Upper bound on the raw message pulled for a single `get_message`. */
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

/** imapflow's own idle timeout, which ends a silent command as a dropped connection. */
const IMAPFLOW_SOCKET_TIMEOUT_MS = 5 * 60_000;

/** The longest delay a Node timer takes; past it the timer fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Kept past the longest deadline this server sets, so that one always fires first. */
export function socketTimeoutFor(config: ImapConfig): number {
  const largestPart = Math.max(
    config.maxAttachmentBytes,
    config.maxDownloadBytes,
    config.maxExtractBytes,
    MAX_SOURCE_BYTES
  );
  const longest = downloadDeadline(largestPart, config.commandTimeoutMs);
  return Math.min(
    MAX_TIMER_MS,
    Math.max(IMAPFLOW_SOCKET_TIMEOUT_MS, longest + 10_000)
  );
}

/** The command timeout plus 10 seconds per MiB the cap allows. */
export function downloadDeadline(
  maxBytes: number,
  commandTimeoutMs: number
): number {
  return commandTimeoutMs + Math.ceil(maxBytes / (1024 * 1024)) * 10_000;
}

/**
 * The largest IMAP responses this server ever asks for. Attachments are
 * downloaded in 64 KiB partial fetches, so the biggest literal is the 2 MiB
 * source of get_message; a line without literals is at its longest in the
 * SEARCH answer of a very large folder.
 */
export const IMAP_RESPONSE_LIMITS = {
  maxLiteralSize: 4 * 1024 * 1024,
  maxLineLength: 64 * 1024 * 1024,
  maxResponseSize: 96 * 1024 * 1024,
} as const;

/**
 * How long opening a connection may take, LOGIN included. imapflow's own
 * connect deadline ends at the TCP handshake; after that only its idle timer
 * runs, and any line from the server re-arms it.
 */
const CONNECT_TIMEOUT_MS = 60_000;

/**
 * The code of this server's own command timeout. It is not a dropped
 * connection: the command may still be running — or have run — on the
 * server, so the connection is closed and the call is not repeated.
 */
export const COMMAND_TIMEOUT = 'COMMAND_TIMEOUT';

/** The code of a call the client gave up on; handled like a timeout once a command is in flight. */
export const CANCELLED = 'CANCELLED';

/** The code of a call that waited out its deadline behind another call's mailbox lock. */
export const MAILBOX_BUSY = 'MAILBOX_BUSY';

/** The code of a call whose connection was set aside while it waited; nothing was sent, so it is retried. */
const RETIRED = 'RETIRED';

/** The calls working on one connection, each counted until its work has settled. */
interface Usage {
  holders: number;
  lockless: number;
  /** Detached from new calls; closed once the last call on it is done. */
  retired: boolean;
  /** Calls waiting here for a mailbox lock, sent elsewhere once the connection is retired. */
  waiters: Set<(error: MailError) => void>;
}

/** One attempt of a call: how many of its writes may have reached the server. */
interface Attempt {
  sent: number;
}

/**
 * How long a refused connection attempt is answered from memory.
 *
 * Every tool call opens the connection lazily, and a connection that failed to
 * open is not kept — so before this, every call after a refused login was a
 * fresh LOGIN against the operator's provider. Providers lock an account after
 * a handful of those, and "check IMAP_USER and IMAP_PASSWORD" is exactly the
 * answer a model retries. Ten seconds is long enough that a retry loop cannot
 * be the thing that locks the mailbox, and short enough that a corrected
 * password is picked up on the next real attempt.
 */
export const LOGIN_COOLDOWN_MS = 10_000;

/** Folders one listing may carry. Past this the rest is counted, not dropped in silence. */
export const MAX_MAILBOXES = 1000;
/**
 * Folders whose counters are fetched one STATUS at a time when the server has
 * no LIST-STATUS, and the wall-clock budget those requests share.
 *
 * imapflow's `list({ statusQuery })` falls back to one STATUS per selectable
 * folder on such a server, with no ceiling, and the command timeout around the
 * whole call does not end the commands — imapflow runs them to the end of the
 * list on the same connection, so the next tool call waits behind them. A
 * shared namespace with a few thousand folders turned one listing into minutes
 * during which nothing else answered. Here the fallback is the server's own:
 * STATUS for the first folders, a clock checked before each request, and the
 * rest listed without counters and counted in the answer.
 */
export const MAX_STATUS_QUERIES = 100;
export const STATUS_BUDGET_MS = 20_000;

export interface MailboxSummary {
  path: string;
  name: string;
  delimiter: string;
  specialUse: string | undefined;
  subscribed: boolean;
  selectable: boolean;
  messages: number | undefined;
  unseen: number | undefined;
  uidNext: number | undefined;
}

export interface MailboxListing {
  mailboxes: MailboxSummary[];
  /** Folders the server listed, including those past {@link MAX_MAILBOXES}. */
  total: number;
  /**
   * Selectable folders whose counters were not fetched: past the per-call
   * STATUS ceiling or its time budget, or refused by the server.
   */
  statusOmitted: number;
}

/**
 * Connection manager around a single IMAP account.
 *
 * Reads take the mailbox lock read-only and use BODY.PEEK throughout, so
 * fetching a message never changes what the human sees as unread. The only
 * exception is deliberate and explicit: {@link tagSeen}, which writes the
 * server's own bookkeeping keyword.
 */
export class ImapClient {
  private connection: ImapConnection | undefined;
  private connecting: Promise<ImapConnection> | undefined;
  private readonly usage = new WeakMap<ImapConnection, Usage>();
  /** Connections set aside while calls still worked on them; closed with the client too. */
  private readonly retired = new Set<ImapConnection>();
  /**
   * The last refused connection attempt, answered from memory for
   * {@link LOGIN_COOLDOWN_MS}. Deliberately not cleared by {@link forget}: the
   * one reconnect a dropped connection is allowed must not become the second
   * failed login in the same second.
   */
  private refused: { at: number; error: MailError } | undefined;

  constructor(
    private readonly config: Config,
    private readonly factory: ImapClientFactory = defaultFactory
  ) {}

  /** Credentials are checked per call, not at startup. */
  private assertConfigured(): void {
    const missing = missingConfigKeys(this.config);
    if (missing.length > 0) {
      throw new Error(missingConfigMessage(missing));
    }
  }

  private async openConnection(): Promise<ImapConnection> {
    this.assertConfigured();
    if (this.connection !== undefined) return this.connection;
    if (this.connecting !== undefined) return this.connecting;

    const refused = this.refused;
    if (refused !== undefined) {
      const elapsed = Date.now() - refused.at;
      if (elapsed < LOGIN_COOLDOWN_MS) {
        const next = new Date(refused.at + LOGIN_COOLDOWN_MS).toISOString();
        throw new MailError(
          `${refused.error.message} (repeated from memory: the connection was ` +
            `refused ${Math.round(elapsed / 1000)} seconds ago and is not ` +
            `retried for ${LOGIN_COOLDOWN_MS / 1000} seconds, so a wrong ` +
            `password cannot lock the account; next attempt possible at ${next})`,
          refused.error.code,
          refused.error.responseText
        );
      }
      this.refused = undefined;
    }

    this.connecting = (async () => {
      // Yield once, so the assignment above has happened before anything
      // below can clear it. A factory that throws synchronously used to run
      // the `finally` first and then be overwritten by the rejected promise,
      // which every later call then received.
      await Promise.resolve();
      try {
        const client = this.factory(this.config.imap);
        // A server that drops an idle connection surfaces as an 'error' event,
        // and an unhandled one ends the process; one that logs out cleanly
        // only closes. Either way the next call reconnects, without first
        // failing on the dead connection. A client that has already been
        // replaced must not take its successor with it.
        const drop = () => {
          if (this.connection === client) this.connection = undefined;
        };
        client.on('error', drop);
        client.on('close', drop);
        try {
          await withTimeout(
            client.connect(),
            'CONNECT',
            CONNECT_TIMEOUT_MS,
            'CONNECT_TIMEOUT'
          );
        } catch (error) {
          // A stalled LOGIN would otherwise hold every caller on this promise.
          closeQuietly(client);
          throw error;
        }
        this.connection = client;
        return client;
      } catch (error) {
        // A ToolInputError cannot come out of a connect; everything else is
        // remembered, whatever its status. A refused password and a refused
        // socket look the same to a provider counting attempts.
        const wrapped = asMailError(error);
        this.refused = { at: Date.now(), error: wrapped };
        throw wrapped;
      } finally {
        // Also on the path where the factory itself threw: a rejected promise
        // left in `connecting` would answer every later call with the same
        // rejection for the life of the process.
        this.connecting = undefined;
      }
    })();
    return this.connecting;
  }

  /**
   * Runs `fn` with the mailbox open and the lock held.
   *
   * A dropped connection is retried exactly once: IMAP sessions are long-lived
   * and idle ones get reaped by servers and NAT gateways alike, so the first
   * call after a pause routinely fails for reasons that have nothing to do with
   * the request.
   */
  async withMailbox<T>(
    mailbox: string | undefined,
    readOnly: boolean,
    signal: AbortSignal | undefined,
    fn: (client: ImapConnection, path: string) => Promise<T>
  ): Promise<T> {
    const path = mailbox ?? this.config.imap.mailbox;
    const started = Date.now();
    try {
      return await this.run(path, readOnly, signal, fn);
    } catch (error) {
      if (!this.retryable(error, started)) throw error;
      return await this.run(path, readOnly, signal, fn);
    }
  }

  private async run<T>(
    path: string,
    readOnly: boolean,
    signal: AbortSignal | undefined,
    fn: (client: ImapConnection, path: string) => Promise<T>
  ): Promise<T> {
    throwIfCancelled(signal);
    const client = await this.connectionFor(signal);
    const usage = this.usageOf(client);
    const attempt: Attempt = { sent: 0 };
    const ms = this.commandTimeoutMs;
    let locking: Promise<{ release(): void }> | undefined;
    let lock: { release(): void } | undefined;
    let leave: (() => void) | undefined;
    let work: Promise<T> | undefined;
    let moved!: (error: MailError) => void;
    const elsewhere = new Promise<never>((_resolve, reject) => {
      moved = reject;
    });
    usage.waiters.add(moved);
    try {
      locking = client.getMailboxLock(path, { readOnly });
      lock = await withTimeout(
        unlessCancelled(Promise.race([locking, elsewhere]), signal),
        'SELECT',
        ms
      );
      usage.waiters.delete(moved);
      leave = this.enter(client, 'holders');
      // A NOOP before SEARCH: without it the server is free to keep reporting
      // the mailbox as it looked when the connection was opened, and mail that
      // arrived since then stays invisible.
      await withTimeout(unlessCancelled(client.noop(), signal), 'NOOP', ms);
      // imapflow's NOOP swallows a failure, and a connection that died under
      // it has dropped its selected mailbox.
      if (client.mailbox === false) {
        throw new MailError('The IMAP connection was lost', 'NoConnection');
      }
      work = fn(guard(client, signal, attempt), path);
      return await unlessCancelled(work, signal);
    } catch (error) {
      usage.waiters.delete(moved);
      const mailError = asMailError(error);
      if (lock === undefined) {
        throw marked(this.failedWaiting(client, mailError, locking), attempt);
      }
      if (mailError.code === CANCELLED) {
        this.abandon(client, this.active(client) - 1);
      } else if (mailError.code === COMMAND_TIMEOUT || isLost(mailError)) {
        // Gone, or past its own deadline: whatever was sent ahead of it expired first.
        this.forget(client);
      }
      throw marked(mailError, attempt);
    } finally {
      if (lock !== undefined) {
        const held = lock;
        const done = () => {
          held.release();
          leave?.();
        };
        // Held until a cancelled call's command is done: a SELECT slipping in would move its EXPUNGE.
        if (work === undefined) done();
        else work.then(done, done);
      }
    }
  }

  /** A call that never got its lock; what is on the wire belongs to someone else unless nobody is here. */
  private failedWaiting(
    client: ImapConnection,
    error: MailError,
    locking: Promise<{ release(): void }> | undefined
  ): MailError {
    const giveBack = () =>
      locking?.then(
        (granted) => granted.release(),
        () => undefined
      );
    if (error.code === RETIRED) {
      giveBack();
      return error;
    }
    if (error.code !== CANCELLED && error.code !== COMMAND_TIMEOUT) {
      if (isLost(error)) this.forget(client);
      return error;
    }
    giveBack();
    if (this.usageOf(client).holders > 0) {
      return error.code === CANCELLED
        ? error
        : new MailError(
            `Another call held the mailbox for ${describeSeconds(this.commandTimeoutMs)}, ` +
              'so this one gave up before sending anything',
            MAILBOX_BUSY
          );
    }
    this.abandon(client, this.active(client));
    return error;
  }

  /** Runs `fn` without selecting a mailbox, for LIST/STATUS/CREATE style calls. */
  async withConnection<T>(
    signal: AbortSignal | undefined,
    fn: (client: ImapConnection) => Promise<T>
  ): Promise<T> {
    const started = Date.now();
    const once = async (): Promise<T> => {
      throwIfCancelled(signal);
      const client = await this.connectionFor(signal);
      const attempt: Attempt = { sent: 0 };
      const leave = this.enter(client, 'lockless');
      let work: Promise<T> | undefined;
      try {
        work = fn(guard(client, signal, attempt));
        return await unlessCancelled(work, signal);
      } catch (error) {
        const mailError = asMailError(error);
        if (mailError.code === CANCELLED) {
          this.abandon(client, this.active(client) - 1);
        } else if (mailError.code === COMMAND_TIMEOUT || isLost(mailError)) {
          this.forget(client);
        }
        throw marked(mailError, attempt);
      } finally {
        if (work === undefined) leave();
        else work.then(leave, leave);
      }
    };
    try {
      return await once();
    } catch (error) {
      if (!this.retryable(error, started)) throw error;
      return await once();
    }
  }

  /** The shared connection, or a fresh one if it was set aside while this call waited for it. */
  private async connectionFor(
    signal: AbortSignal | undefined
  ): Promise<ImapConnection> {
    // Stops waiting, not connecting: the connect is shared with every other caller.
    const client = await unlessCancelled(this.openConnection(), signal);
    if (!this.usageOf(client).retired) return client;
    return unlessCancelled(this.openConnection(), signal);
  }

  /**
   * Whether a failed call gets its one retry: only a connection that dropped
   * under it. Never this server's own command timeout — the command may have
   * run on the server — and never a connect that was itself refused during
   * this call, which the retry would only answer from memory. Never once a
   * write of the call may have reached the server.
   */
  private retryable(error: unknown, started: number): boolean {
    if (error instanceof ToolInputError) return false;
    const mailError = asMailError(error);
    if (
      mailError.code === COMMAND_TIMEOUT ||
      mailError.code === CANCELLED ||
      mailError.code === MAILBOX_BUSY
    ) {
      return false;
    }
    if (this.refused !== undefined && this.refused.at >= started) return false;
    return (
      (isLost(mailError) || mailError.code === RETIRED) && mailError.neverSent
    );
  }

  /**
   * Closes a connection. Only the one that failed: a concurrent call may
   * already have replaced it, and closing the successor would fail that
   * call's retry.
   */
  private forget(client: ImapConnection | undefined = this.connection): void {
    if (client === undefined) return;
    closeQuietly(client);
    if (this.connection === client) this.connection = undefined;
    this.retired.delete(client);
  }

  /** After a call gave up: closed at once if nobody else works on it, else set aside until they are done. */
  private abandon(client: ImapConnection, others: number): void {
    if (others <= 0) {
      this.forget(client);
      return;
    }
    if (this.connection === client) this.connection = undefined;
    const usage = this.usageOf(client);
    usage.retired = true;
    this.retired.add(client);
    for (const move of usage.waiters) {
      move(
        new MailError(
          'The connection was set aside while this call waited for the mailbox',
          RETIRED,
          '',
          { neverSent: true }
        )
      );
    }
    usage.waiters.clear();
    this.closeIfIdle(client);
  }

  /** Counts a call on a connection until the returned function is called, once. */
  private enter(
    client: ImapConnection,
    role: 'holders' | 'lockless'
  ): () => void {
    const usage = this.usageOf(client);
    usage[role] += 1;
    let left = false;
    return () => {
      if (left) return;
      left = true;
      usage[role] -= 1;
      this.closeIfIdle(client);
    };
  }

  private closeIfIdle(client: ImapConnection): void {
    const usage = this.usageOf(client);
    if (usage.retired && usage.holders + usage.lockless === 0) {
      this.forget(client);
    }
  }

  private active(client: ImapConnection): number {
    const usage = this.usageOf(client);
    return usage.holders + usage.lockless;
  }

  private usageOf(client: ImapConnection): Usage {
    let usage = this.usage.get(client);
    if (usage === undefined) {
      usage = { holders: 0, lockless: 0, retired: false, waiters: new Set() };
      this.usage.set(client, usage);
    }
    return usage;
  }

  async listMailboxes(
    signal: AbortSignal | undefined
  ): Promise<MailboxListing> {
    return this.withConnection(signal, async (client) => {
      const statusQuery = { messages: true, unseen: true, uidNext: true };
      // With LIST-STATUS the counters ride in the same round trip as the list.
      // Without it imapflow would issue one STATUS per folder with no ceiling
      // (see MAX_STATUS_QUERIES), so the fallback is done here, bounded.
      const listStatus = client.capabilities.has('LIST-STATUS');
      const listed = await withTimeout(
        client.list(listStatus ? { statusQuery } : undefined),
        'LIST',
        this.commandTimeoutMs
      );
      const entries = listed.slice(0, MAX_MAILBOXES);
      let statusOmitted = 0;
      let stalled = false;
      if (!listStatus) {
        const deadline = Date.now() + STATUS_BUDGET_MS;
        let queried = 0;
        for (const entry of entries) {
          if (entry.flags.has('\\Noselect') || entry.flags.has('\\NonExistent'))
            continue;
          if (
            stalled ||
            queried >= MAX_STATUS_QUERIES ||
            Date.now() >= deadline
          ) {
            statusOmitted += 1;
            continue;
          }
          queried += 1;
          try {
            const status = await withTimeout(
              client.status(entry.path, statusQuery),
              'STATUS',
              Math.max(
                1,
                Math.min(this.commandTimeoutMs, deadline - Date.now())
              )
            );
            // imapflow answers a refused STATUS with false, not with an error.
            if (status === false) {
              statusOmitted += 1;
              continue;
            }
            entry.status = status;
          } catch (error) {
            // A folder the server refuses to STATUS is still a folder. A
            // dropped connection, though, is the whole listing's problem.
            if (isConnectionError(error)) throw error;
            statusOmitted += 1;
            // A STATUS past its deadline is still queued on this connection.
            if (asMailError(error).code === COMMAND_TIMEOUT) stalled = true;
          }
        }
      }
      if (stalled) {
        // That STATUS is still queued; the calls around it are left to finish.
        const connection = unguarded(client);
        this.abandon(connection, this.active(connection) - 1);
      }
      return {
        mailboxes: entries.map((entry) => ({
          path: entry.path,
          name: entry.name,
          delimiter: entry.delimiter,
          specialUse: entry.specialUse,
          subscribed: entry.subscribed,
          selectable: !entry.flags.has('\\Noselect'),
          messages: entry.status?.messages,
          unseen: entry.status?.unseen,
          uidNext: entry.status?.uidNext,
        })),
        total: listed.length,
        statusOmitted,
      };
    });
  }

  /**
   * Whether the account can store the bookkeeping keyword.
   *
   * `\*` in PERMANENTFLAGS means the server accepts arbitrary keywords. Some
   * providers accept none at all, and there the new-mail tracking cannot work —
   * better to say so than to tag silently into the void.
   */
  keywordSupported(permanentFlags: Set<string> | false | undefined): boolean {
    const keyword = this.config.imap.seenKeyword;
    if (keyword === '') return false;
    return canStoreFlag(permanentFlags, keyword);
  }

  get seenKeyword(): string {
    return this.config.imap.seenKeyword;
  }

  get defaultMailbox(): string {
    return this.config.imap.mailbox;
  }

  get maxMessages(): number {
    return this.config.imap.maxMessages;
  }

  get user(): string | undefined {
    return this.config.imap.user;
  }

  get commandTimeoutMs(): number {
    return this.config.imap.commandTimeoutMs;
  }

  /**
   * Reads the threading headers of one message, for linking a draft into an
   * existing conversation.
   *
   * Only the Message-ID and the References chain are taken; nothing the sender
   * wrote as prose comes back from here.
   */
  async threadHeaders(
    mailbox: string | undefined,
    uid: number,
    signal: AbortSignal | undefined
  ): Promise<{ messageId: string | undefined; references: string[] }> {
    return this.withMailbox(mailbox, true, signal, async (connection) => {
      const [message] = await collectFetch(
        connection.fetch(
          [uid],
          { uid: true, envelope: true, headers: ['references', 'in-reply-to'] },
          { uid: true }
        ),
        [uid],
        this.commandTimeoutMs
      );
      if (message !== undefined) {
        const { references, inReplyTo } = parseThreadHeaders(
          message.headers?.toString('utf-8') ?? ''
        );
        // The envelope's id is the server's rendering of a header the sender
        // wrote. It goes into the In-Reply-To header of a draft, so it has to
        // be shaped like a Message-ID before it is written anywhere: a value
        // with a control character or of unbounded length is *absent*, not a
        // failed draft with a puzzling "must not contain line breaks".
        const envelopeId = message.envelope?.messageId;
        const messageId =
          envelopeId !== undefined && isMessageId(envelopeId)
            ? envelopeId
            : undefined;
        return {
          messageId,
          references: referenceChain(references, inReplyTo, messageId),
        };
      }
      throw new ToolInputError(
        `imap-mcp: no message with UID ${uid} in this mailbox.`
      );
    });
  }

  /** imapflow answers a refused SEARCH (NO/BAD) with false, which is not "no matches". */
  async search(
    client: ImapConnection,
    query: SearchObject,
    onRefusal: 'empty' | 'throw'
  ): Promise<number[]> {
    const found = await withTimeout(
      client.search(query, { uid: true }),
      'SEARCH',
      this.commandTimeoutMs
    );
    if (Array.isArray(found)) return found;
    // undefined: imapflow found no selected mailbox, so the connection is gone.
    if (found !== false) {
      throw new MailError('The IMAP connection was lost', 'NoConnection');
    }
    if (onRefusal === 'empty') return [];
    throw new MailError(
      'The mail server refused this search',
      'SEARCH_REFUSED'
    );
  }

  /** Envelope-level fetch, newest UID first. */
  async fetchSummaries(
    client: ImapConnection,
    uids: number[]
  ): Promise<FetchMessageObject[]> {
    if (uids.length === 0) return [];
    const messages = await collectFetch(
      client.fetch(
        uids,
        {
          uid: true,
          envelope: true,
          flags: true,
          size: true,
          internalDate: true,
          // `hasAttachments` in every summary is read off the body structure.
          // Without this item it was always false — the projection asked a
          // question the fetch never carried the answer to.
          bodyStructure: true,
        },
        { uid: true }
      ),
      uids,
      this.commandTimeoutMs
    );
    return messages.toSorted((a, b) => b.uid - a.uid);
  }

  /**
   * Adds the bookkeeping keyword to the given UIDs.
   *
   * This is the one write the server performs on its own initiative, and it
   * stays available under the default IMAP_READ_ONLY: without it `list_new_messages`
   * would return the same mail forever. It touches no flag a human interacts
   * with — `\Seen` in particular is left alone.
   */
  async tagSeen(client: ImapConnection, uids: number[]): Promise<void> {
    if (uids.length === 0 || this.config.imap.seenKeyword === '') return;
    requireOk(
      await withTimeout(
        client.messageFlagsAdd(uids, [this.config.imap.seenKeyword], {
          uid: true,
        }),
        'STORE',
        this.commandTimeoutMs
      ),
      'STORE',
      client
    );
  }

  /**
   * Every folder the server lists with the role it gave it, and how it came to
   * that role — without the STATUS round trips {@link listMailboxes} makes.
   *
   * For callers that look for one folder by role. Counting messages in every
   * folder of a large or shared account to find Drafts is a minute of work for
   * a path.
   */
  async listMailboxRoles(signal: AbortSignal | undefined): Promise<
    Array<{
      path: string;
      specialUse: string | undefined;
      specialUseSource: 'user' | 'extension' | 'name' | undefined;
      selectable: boolean;
    }>
  > {
    return this.withConnection(signal, async (client) => {
      const listed = await withTimeout(
        client.list(),
        'LIST',
        this.commandTimeoutMs
      );
      return listed.slice(0, MAX_MAILBOXES).map((entry) => ({
        path: entry.path,
        specialUse: entry.specialUse,
        specialUseSource: entry.specialUseSource,
        selectable:
          !entry.flags.has('\\Noselect') && !entry.flags.has('\\NonExistent'),
      }));
    });
  }

  async close(): Promise<void> {
    // A connect still in flight would otherwise set `this.connection` after
    // the close and keep the session open.
    await this.connecting?.catch(() => undefined);
    for (const retired of this.retired) closeQuietly(retired);
    this.retired.clear();
    // Held locally: a logout ends in a 'close' event, which already clears
    // `this.connection` before a failed logout gets to the fallback.
    const connection = this.connection;
    if (connection === undefined) return;
    try {
      await connection.logout();
    } catch {
      connection.close();
    }
    this.connection = undefined;
  }
}

/**
 * The result of a write command, or a {@link MailError} when the server said no.
 *
 * imapflow does not throw for a NO or BAD to STORE, COPY, MOVE or EXPUNGE: it
 * resolves to `false` (or, when its own preconditions are not met, to
 * `undefined`). A call site that awaits the command and moves on reports a
 * refused move as done, and writes it to the audit log as done.
 */
export function requireOk<T>(
  result: T | false | undefined | null,
  command: string,
  connection?: Pick<ImapConnection, 'usable'>
): T {
  if (result === false || result === undefined || result === null) {
    // imapflow answers a command its connection dropped under with `false` as well.
    if (connection?.usable === false) {
      throw new MailError(
        `IMAP ${command} lost its connection before the server answered, so it ` +
          'may have been carried out or not — check the mailbox before trying again.',
        'NoConnection'
      );
    }
    throw new MailError(
      `IMAP ${command} was refused by the mail server, so the change was not ` +
        'made in full. List the mailbox to see what state it is in before ' +
        'trying again.',
      'COMMAND_REFUSED'
    );
  }
  return result;
}

/** Message-IDs one draft's References header may carry. */
export const MAX_REFERENCES = 20;

/**
 * The Message-IDs in the References and In-Reply-To headers of a raw header
 * block, each kept apart and in the order the sender wrote them.
 *
 * Read per header, not as one list of everything that looks like an id: the
 * order of the two headers in the message says nothing about the order of the
 * thread, and Gmail and Apple Mail write In-Reply-To first.
 */
export function parseThreadHeaders(raw: string): {
  references: string[];
  inReplyTo: string[];
} {
  const found = { references: [] as string[], inReplyTo: [] as string[] };
  for (const line of raw.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const header = /^(references|in-reply-to):(.*)$/is.exec(line);
    if (header?.[1] === undefined) continue;
    const ids = (header[2]?.match(/<[^\s<>]{1,255}>/g) ?? []).filter(
      isMessageId
    );
    found[
      header[1].toLowerCase() === 'references' ? 'references' : 'inReplyTo'
    ].push(...ids);
  }
  return found;
}

/**
 * The References chain for a reply: the parent's own chain, oldest first, then
 * the parent.
 *
 * RFC 5322 puts the oldest ancestor first and the message replied to last. Ids
 * only In-Reply-To names come after the References ones, the parent's own id
 * last, and the first occurrence of a repeated id wins. A long thread keeps its
 * root and its most recent {@link MAX_REFERENCES} - 1 ancestors — the two ends
 * a client threads by — rather than only the tail.
 */
export function referenceChain(
  references: string[],
  inReplyTo: string[],
  parent: string | undefined
): string[] {
  const chain = [
    ...new Set([
      ...references,
      ...inReplyTo,
      ...(parent === undefined ? [] : [parent]),
    ]),
  ];
  if (chain.length <= MAX_REFERENCES) return chain;
  return [chain[0] as string, ...chain.slice(-(MAX_REFERENCES - 1))];
}

/** Rejects a promise that outlives the command timeout. */
export async function withTimeout<T>(
  promise: Promise<T>,
  command: string,
  ms: number,
  code: string = COMMAND_TIMEOUT
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new MailError(
                `IMAP ${command} timed out after ${describeSeconds(ms)}`,
                code
              )
            ),
          Math.min(ms, MAX_TIMER_MS)
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function describeSeconds(ms: number): string {
  const seconds = ms / 1000;
  return seconds === 1 ? '1 second' : `${seconds} seconds`;
}

/** Settles like `promise`, or rejects with CANCELLED once `signal` aborts; `promise` runs on. */
export function unlessCancelled<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined
): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(cancelledError());
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(cancelledError());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
  });
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw cancelledError();
}

const guarded = new WeakMap<ImapConnection, ImapConnection>();

/** What a call's `fn` works on: nothing goes out once it is cancelled, and every write it starts is counted. */
function guard(
  client: ImapConnection,
  signal: AbortSignal | undefined,
  attempt: Attempt
): ImapConnection {
  const proxy = new Proxy(client, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      const write = typeof property === 'string' && WRITES.has(property);
      return (...args: unknown[]) => {
        throwIfCancelled(signal);
        const result: unknown = (
          value as (...rest: unknown[]) => unknown
        ).apply(target, args);
        if (write) {
          attempt.sent += 1;
          if (result instanceof Promise) {
            result.catch((error: unknown) => {
              if (rejectedBeforeSending(error)) attempt.sent -= 1;
            });
          }
        }
        return result;
      };
    },
  });
  guarded.set(proxy, client);
  return proxy;
}

function unguarded(connection: ImapConnection): ImapConnection {
  return guarded.get(connection) ?? connection;
}

function rejectedBeforeSending(error: unknown): boolean {
  const site = (error as { rejectedFrom?: unknown } | null)?.rejectedFrom;
  return typeof site === 'string' && NEVER_SENT.has(site);
}

/** The connection is gone, whichever way imapflow says so. */
function isLost(error: MailError): boolean {
  return isConnectionError(error) || READ_RETRY_CODES.has(error.code ?? '');
}

/** Marks an error of an attempt none of whose writes reached the server. */
function marked(error: MailError, attempt: Attempt): MailError {
  if (attempt.sent > 0 || error.neverSent) return error;
  return new MailError(error.message, error.code, error.responseText, {
    neverSent: true,
  });
}

/** Whether a failed write may still have been carried out on the server. */
export function mayHaveRun(error: unknown): boolean {
  if (error instanceof ToolInputError || rejectedBeforeSending(error)) {
    return false;
  }
  const mailError = asMailError(error);
  return mailError.code === COMMAND_TIMEOUT || isLost(mailError);
}

function cancelledError(): MailError {
  return new MailError('The client cancelled this call', CANCELLED);
}

const CONNECTION_ERROR_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENOTCONN',
  'NoConnection',
]);

/**
 * imapflow's own codes for a connection that went away under a command. A
 * read is simply asked again; a write is not, because the server may have
 * carried it out before the connection died.
 */
const READ_RETRY_CODES = new Set([
  'EConnectionClosed',
  'StateLogout',
  'ETIMEOUT',
  'ECONNABORTED',
]);

/** Where imapflow rejects a command it never put on the wire. */
const NEVER_SENT = new Set([
  'execClosed',
  'execNoSocket',
  'noSocket',
  'writeNoSocket',
  'writeAfterLogout',
  'sendAfterLogout',
  'preCheckWaiter',
]);

/** The methods of a connection that change the mailbox. */
const WRITES = new Set([
  'append',
  'messageFlagsAdd',
  'messageFlagsRemove',
  'messageMove',
  'messageCopy',
  'messageDelete',
  'mailboxCreate',
  'mailboxRename',
  'mailboxDelete',
]);

function closeQuietly(client: ImapConnection): void {
  try {
    client.close();
  } catch {
    // Already gone; nothing to clean up.
  }
}

/**
 * The rows of a FETCH, bounded in time and filtered to what was asked for.
 *
 * imapflow yields every untagged FETCH that arrives during the command —
 * unsolicited flag updates without a UID included — and a row of a message
 * nobody asked for is not one of the answers.
 */
export async function collectFetch(
  rows: AsyncIterable<FetchMessageObject>,
  uids: readonly number[],
  ms: number
): Promise<FetchMessageObject[]> {
  const wanted = new Set(uids);
  return withTimeout(
    (async () => {
      const found: FetchMessageObject[] = [];
      for await (const row of rows) {
        if (Number.isSafeInteger(row.uid) && wanted.has(row.uid)) {
          found.push(row);
        }
      }
      return found;
    })(),
    'FETCH',
    ms
  );
}

function isConnectionError(error: unknown): boolean {
  if (error instanceof MailError) {
    return error.code !== undefined && CONNECTION_ERROR_CODES.has(error.code);
  }
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && CONNECTION_ERROR_CODES.has(code);
}

/**
 * Normalises whatever imapflow threw into a {@link MailError}.
 *
 * Only the response text is carried over, never the whole error object: it
 * holds the command that was sent, and for a LOGIN that means the password.
 */
export function asMailError(error: unknown): MailError {
  if (error instanceof MailError) return error;
  if (error instanceof ToolInputError) throw error;
  const source = error as
    | {
        message?: unknown;
        code?: unknown;
        serverResponseCode?: unknown;
        authenticationFailed?: unknown;
        tlsFailed?: unknown;
        responseText?: unknown;
        response?: unknown;
      }
    | null
    | undefined;
  const message =
    typeof source?.message === 'string' ? source.message : String(error);
  // imapflow puts a refused LOGIN in `authenticationFailed` and the server's
  // [CODE] in `serverResponseCode`, and leaves `code` unset — the hints keyed
  // on the code never fired against the real library.
  const code =
    source?.authenticationFailed === true
      ? 'AUTHENTICATIONFAILED'
      : source?.tlsFailed === true
        ? 'TLSFAILED'
        : typeof source?.code === 'string'
          ? source.code
          : typeof source?.serverResponseCode === 'string'
            ? source.serverResponseCode
            : undefined;
  const responseText =
    typeof source?.responseText === 'string'
      ? source.responseText
      : typeof source?.response === 'string'
        ? source.response
        : '';
  return new MailError(`IMAP error: ${message}`, code, responseText);
}
