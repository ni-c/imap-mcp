#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfig } from './config.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();

  if (config.imap.insecureTls) {
    console.error(
      'imap-mcp: IMAP_INSECURE_TLS=true — certificate validation is disabled for the mail connections'
    );
  }
  if (!config.allowWrite) {
    console.error(
      'imap-mcp: IMAP_ALLOW_WRITE is not "true" — the mailbox write tools are not registered'
    );
  }
  const server = createServer(config);
  // stdout belongs to the protocol; everything human-readable goes to stderr.
  await server.connect(new StdioServerTransport());
  console.error(
    config.imap.host === undefined
      ? 'imap-mcp: connected without configuration — tools are listed but every call will fail'
      : `imap-mcp: connected, mailbox "${config.imap.mailbox}" on ${config.imap.host}`
  );
}

main().catch((error: unknown) => {
  console.error('imap-mcp: fatal error:', error);
  process.exit(1);
});
