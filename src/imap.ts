import { ImapFlow } from 'imapflow';
import type {
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

/**
 * Everything this server needs from an IMAP connection.
 *
 * Narrowing imapflow to an interface is what makes the tools testable: the unit
 * tests inject a fake through {@link ImapClientFactory} instead of standing up a
 * real server, and the surface stays small enough that the fake cannot silently
 * drift away from the real thing.
 */
export interface ImapConnection {
  connect(): Promise<void>;
  logout(): Promise<void>;
  close(): void;
  noop(): Promise<void>;
  list(options?: {
    statusQuery?: { messages?: boolean; unseen?: boolean; uidNext?: boolean };
  }): Promise<ListResponse[]>;
  status(path: string, query: Record<string, boolean>): Promise<StatusObject>;
  getMailboxLock(
    path: string,
    options?: { readOnly?: boolean }
  ): Promise<{ path: string; release(): void }>;
  search(
    query: SearchObject,
    options?: { uid?: boolean }
  ): Promise<number[] | false>;
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
  messageMove(
    range: number[],
    destination: string,
    options?: { uid?: boolean }
  ): Promise<unknown>;
  messageCopy(
    range: number[],
    destination: string,
    options?: { uid?: boolean }
  ): Promise<unknown>;
  messageDelete(range: number[], options?: { uid?: boolean }): Promise<boolean>;
  append(
    path: string,
    content: string | Buffer,
    flags?: string[],
    date?: Date
  ): Promise<unknown>;
  mailboxCreate(path: string): Promise<unknown>;
  mailboxRename(path: string, newPath: string): Promise<unknown>;
  mailboxDelete(path: string): Promise<unknown>;
  readonly capabilities: Map<string, boolean | number>;
  readonly mailbox: false | { path: string; permanentFlags: Set<string> };
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
  }) as unknown as ImapConnection;

/** How long a single IMAP command may take before the call is abandoned. */
const COMMAND_TIMEOUT_MS = 30_000;

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

  private async connection_(): Promise<ImapConnection> {
    this.assertConfigured();
    if (this.connection !== undefined) return this.connection;
    if (this.connecting !== undefined) return this.connecting;

    this.connecting = (async () => {
      const client = this.factory(this.config.imap);
      try {
        await client.connect();
      } catch (error) {
        this.connecting = undefined;
        throw asMailError(error);
      }
      this.connection = client;
      this.connecting = undefined;
      return client;
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
    fn: (client: ImapConnection, path: string) => Promise<T>
  ): Promise<T> {
    const path = mailbox ?? this.config.imap.mailbox;
    try {
      return await this.run(path, readOnly, fn);
    } catch (error) {
      if (!isConnectionError(error)) throw error;
      this.forget();
      return await this.run(path, readOnly, fn);
    }
  }

  private async run<T>(
    path: string,
    readOnly: boolean,
    fn: (client: ImapConnection, path: string) => Promise<T>
  ): Promise<T> {
    const client = await this.connection_();
    let lock: { release(): void } | undefined;
    try {
      lock = await client.getMailboxLock(path, { readOnly });
      // A NOOP before SEARCH: without it the server is free to keep reporting
      // the mailbox as it looked when the connection was opened, and mail that
      // arrived since then stays invisible.
      await withTimeout(client.noop(), 'NOOP');
      return await fn(client, path);
    } catch (error) {
      throw asMailError(error);
    } finally {
      lock?.release();
    }
  }

  /** Runs `fn` without selecting a mailbox, for LIST/STATUS/CREATE style calls. */
  async withConnection<T>(
    fn: (client: ImapConnection) => Promise<T>
  ): Promise<T> {
    try {
      return await fn(await this.connection_());
    } catch (error) {
      if (!isConnectionError(error)) throw asMailError(error);
      this.forget();
      try {
        return await fn(await this.connection_());
      } catch (retryError) {
        throw asMailError(retryError);
      }
    }
  }

  private forget(): void {
    try {
      this.connection?.close();
    } catch {
      // Already gone; nothing to clean up.
    }
    this.connection = undefined;
  }

  async listMailboxes(): Promise<MailboxSummary[]> {
    return this.withConnection(async (client) => {
      // statusQuery folds the per-folder counters into the same round trip, so
      // list_mailboxes can answer "which folder, and how much is in it" at once.
      const entries = await withTimeout(
        client.list({
          statusQuery: { messages: true, unseen: true, uidNext: true },
        }),
        'LIST'
      );
      return entries.map((entry) => ({
        path: entry.path,
        name: entry.name,
        delimiter: entry.delimiter,
        specialUse: entry.specialUse,
        subscribed: entry.subscribed,
        selectable: !entry.flags.has('\\Noselect'),
        messages: entry.status?.messages,
        unseen: entry.status?.unseen,
        uidNext: entry.status?.uidNext,
      }));
    });
  }

  /**
   * Whether the account can store the bookkeeping keyword.
   *
   * `\*` in PERMANENTFLAGS means the server accepts arbitrary keywords. Some
   * providers accept none at all, and there the new-mail tracking cannot work —
   * better to say so than to tag silently into the void.
   */
  keywordSupported(permanentFlags: Set<string>): boolean {
    const keyword = this.config.imap.seenKeyword;
    if (keyword === '') return false;
    return permanentFlags.has('\\*') || permanentFlags.has(keyword);
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

  /**
   * Reads the threading headers of one message, for linking a draft into an
   * existing conversation.
   *
   * Only the Message-ID and the References chain are taken; nothing the sender
   * wrote as prose comes back from here.
   */
  async threadHeaders(
    mailbox: string | undefined,
    uid: number
  ): Promise<{ messageId: string | undefined; references: string[] }> {
    return this.withMailbox(mailbox, true, async (connection) => {
      for await (const message of connection.fetch(
        [uid],
        { uid: true, envelope: true, headers: ['references', 'in-reply-to'] },
        { uid: true }
      )) {
        const raw = message.headers?.toString('utf-8') ?? '';
        const ids = raw.match(/<[^\s<>]{1,255}>/g) ?? [];
        const messageId = message.envelope?.messageId;
        const chain = [...ids, ...(messageId === undefined ? [] : [messageId])];
        return {
          messageId,
          // Bounded: a long-running thread accumulates dozens of ids and each
          // one lengthens the header we are about to write.
          references: [...new Set(chain)].slice(-20),
        };
      }
      throw new ToolInputError(
        `imap-mcp: no message with UID ${uid} in this mailbox.`
      );
    });
  }

  async search(client: ImapConnection, query: SearchObject): Promise<number[]> {
    const found = await withTimeout(
      client.search(query, { uid: true }),
      'SEARCH'
    );
    return found === false ? [] : found;
  }

  /** Envelope-level fetch, newest UID first. */
  async fetchSummaries(
    client: ImapConnection,
    uids: number[]
  ): Promise<FetchMessageObject[]> {
    if (uids.length === 0) return [];
    const messages: FetchMessageObject[] = [];
    for await (const message of client.fetch(
      uids,
      {
        uid: true,
        envelope: true,
        flags: true,
        size: true,
        internalDate: true,
      },
      { uid: true }
    )) {
      messages.push(message);
    }
    return messages.sort((a, b) => b.uid - a.uid);
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
    await withTimeout(
      client.messageFlagsAdd(uids, [this.config.imap.seenKeyword], {
        uid: true,
      }),
      'STORE'
    );
  }

  async close(): Promise<void> {
    if (this.connection === undefined) return;
    try {
      await this.connection.logout();
    } catch {
      this.connection.close();
    }
    this.connection = undefined;
  }
}

/** Rejects a promise that outlives the command timeout. */
export async function withTimeout<T>(
  promise: Promise<T>,
  command: string,
  ms: number = COMMAND_TIMEOUT_MS
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
                `IMAP ${command} timed out after ${ms / 1000} seconds`,
                'ETIMEDOUT'
              )
            ),
          ms
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
        responseText?: unknown;
        response?: unknown;
      }
    | null
    | undefined;
  const message =
    typeof source?.message === 'string' ? source.message : String(error);
  const code = typeof source?.code === 'string' ? source.code : undefined;
  const responseText =
    typeof source?.responseText === 'string'
      ? source.responseText
      : typeof source?.response === 'string'
        ? source.response
        : '';
  return new MailError(`IMAP error: ${message}`, code, responseText);
}
