/**
 * Records every change this server makes to the mailbox.
 *
 * The line goes to stderr, which is the one channel the model never reads: the
 * MCP transport owns stdout, and tool results go back to the model. So this is
 * the only place a human can afterwards reconstruct what a hijacked session
 * actually did — the model's own account of events is not evidence.
 *
 * Deliberately no subjects, senders or bodies. An audit line that quotes the
 * mail would put attacker-chosen text into the operator's log viewer, and the
 * facts needed to undo something are the UIDs and the folder, not the prose.
 */
export function audit(
  operation: string,
  details: Record<string, unknown>
): void {
  const fields = Object.entries(details)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${format(value)}`)
    .join(' ');
  console.error(
    `imap-mcp audit ${new Date().toISOString()} ${operation} ${fields}`
  );
}

/** Long UID lists are abbreviated so one bulk call cannot flood the log. */
function format(value: unknown): string {
  if (Array.isArray(value)) {
    return value.length > 20
      ? `[${value.slice(0, 20).join(',')},…+${value.length - 20}]`
      : `[${value.join(',')}]`;
  }
  return String(value);
}
