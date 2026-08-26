import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ElicitRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

import type { Config } from '../src/config.js';
import { DEFAULT_ATTACHMENT_TYPES } from '../src/config.js';
import { createServer } from '../src/server.js';

import { FakeImap, message, type FakeMailbox } from './fake-imap.js';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    imap: {
      host: 'imap.example.net',
      port: 993,
      user: 'me@example.net',
      password: 'secret',
      tls: 'implicit',
      insecureTls: false,
      mailbox: 'INBOX',
      seenKeyword: 'AiSeen',
      draftsMailbox: undefined,
      maxMessages: 100,
      maxAttachmentBytes: 1024 * 1024,
      allowedAttachmentTypes: DEFAULT_ATTACHMENT_TYPES,
      downloadDir: undefined,
      maxDownloadBytes: 25 * 1024 * 1024,
      ...(overrides.imap ?? {}),
    },
    // Mirrors the real default: read-only unless the test says otherwise.
    readOnly: overrides.readOnly ?? true,
    allowTools: overrides.allowTools,
    denyTools: overrides.denyTools,
  };
}

export function defaultMailboxes(): FakeMailbox[] {
  return [
    {
      path: 'INBOX',
      specialUse: '\\Inbox',
      messages: [
        message(1, {
          subject: 'Welcome',
          flags: new Set(['\\Seen', 'AiSeen']),
        }),
        message(2, { subject: 'Invoice 4711' }),
        message(3, {
          subject: 'Please review',
          from: { name: 'Anna', address: 'anna@example.net' },
        }),
      ],
    },
    { path: 'Archive', messages: [] },
    { path: 'Drafts', specialUse: '\\Drafts', messages: [] },
    { path: 'Trash', specialUse: '\\Trash', messages: [] },
  ];
}

/** How a client with elicitation support answers the confirmation dialog. */
export type ElicitBehaviour = 'accept' | 'decline' | 'cancel' | 'error';

export interface Harness {
  client: Client;
  imap: FakeImap;
  /** Every message the server put in front of the user, in order. */
  prompts: string[];
  close(): Promise<void>;
}

/** Boots the real server against the fake IMAP and returns a connected client. */
export async function connect(
  options: {
    config?: Partial<Config>;
    mailboxes?: FakeMailbox[];
    /** Omitted means the client does not support elicitation at all. */
    elicit?: ElicitBehaviour;
  } = {}
): Promise<Harness> {
  const imap = new FakeImap(options.mailboxes ?? defaultMailboxes());
  const config = testConfig(options.config ?? {});
  const prompts: string[] = [];

  const server = createServer(config, { imapFactory: () => imap });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const client = new Client(
    { name: 'test', version: '0.0.0' },
    options.elicit === undefined ? {} : { capabilities: { elicitation: {} } }
  );

  if (options.elicit !== undefined) {
    const behaviour = options.elicit;
    client.setRequestHandler(ElicitRequestSchema, (request) => {
      const params = request.params as { message?: string };
      prompts.push(params.message ?? '');
      if (behaviour === 'error') throw new Error('dialog unavailable');
      if (behaviour === 'cancel') return { action: 'cancel' };
      if (behaviour === 'decline') return { action: 'decline' };
      return { action: 'accept', content: { confirm: true } };
    });
  }

  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  return {
    client,
    imap,
    prompts,
    close: async () => {
      await client.close();
    },
  };
}

export async function toolNames(client: Client): Promise<string[]> {
  const { tools } = await client.listTools();
  return tools.map((tool) => tool.name).sort();
}

export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<CallToolResult> {
  return (await client.callTool({
    name,
    arguments: args,
  })) as CallToolResult;
}

export function textOf(result: CallToolResult): string {
  return result.content
    .map((part) => (part.type === 'text' ? part.text : `[${part.type}]`))
    .join('\n');
}

/** Parses the JSON payload out of a tool result, ignoring any preamble. */
export function jsonOf(result: CallToolResult): unknown {
  const text = textOf(result);
  const start = text.indexOf('{');
  if (start < 0) throw new Error(`no JSON in result: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start));
}

/** Pulls the confirm_token out of a confirmation prompt. */
export function tokenOf(result: CallToolResult): string {
  const match = /confirm_token="([0-9a-f]+)"/.exec(textOf(result));
  if (match?.[1] === undefined) {
    throw new Error(`no confirm token in: ${textOf(result)}`);
  }
  return match[1];
}
