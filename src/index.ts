#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { ToolFilterError } from './tool-filter.js';

async function main(): Promise<void> {
  const config = loadConfig();

  if (config.imap.insecureTls) {
    console.error(
      'imap-mcp: IMAP_INSECURE_TLS=true — certificate validation is disabled for the mail connections'
    );
  }
  if (config.readOnly) {
    console.error(
      'imap-mcp: IMAP_READ_ONLY is not "false" — the mailbox write tools are not registered'
    );
  }
  let server;
  try {
    server = createServer(config);
  } catch (error) {
    // A bad tool list is operator feedback, not a crash.
    if (error instanceof ToolFilterError) {
      console.error(`imap-mcp: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
  // stdout belongs to the protocol; everything human-readable goes to stderr.
  await server.connect(new StdioServerTransport());
  console.error(
    config.imap.host === undefined
      ? 'imap-mcp: connected without configuration — tools are listed but every call will fail'
      : `imap-mcp: connected, mailbox "${config.imap.mailbox}" on ${config.imap.host}`
  );
}

// In a container node runs as PID 1 with no default signal disposition, so
// without this handler `docker stop` waits out the grace period and SIGKILLs.
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

main().catch((error: unknown) => {
  console.error('imap-mcp: fatal error:', error);
  process.exit(1);
});
