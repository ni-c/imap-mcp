import { escapeInvisible } from './analyze.js';
import { mayHaveRun } from './imap.js';

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
 * The one exception is the path of a saved attachment: its filename was chosen
 * by the sender, but it has been through sanitizeFilename — no control or
 * invisible characters, no separators — and without it the line could not say
 * which file to go and delete.
 *
 * That reasoning had a hole: folder names go in these lines too, and on a
 * shared account they are chosen by whoever created the folder. `to=Archive`
 * for a destination of `Archive<U+202E>…` is a log entry that reads as the wrong
 * folder, and a CR in a name rewrites the line a human is looking at. So every
 * string value is quoted and escaped on the way out — see {@link escapeInvisible}
 * and {@link format}. What cannot be seen must not be written here.
 */
/** Runs an audited write; one that may or may not have happened is logged with `outcome=unknown`. */
export async function auditedWrite<T>(
  operation: string,
  details: Record<string, unknown>,
  write: () => Promise<T>
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (mayHaveRun(error)) audit(operation, { ...details, outcome: 'unknown' });
    throw error;
  }
}

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

/**
 * One value as one token.
 *
 * Fields are `key=value` joined by spaces, so a bare value is a way to write
 * fields of one's own: a mailbox called `Archive uids=[1] to=Trash` made a line
 * that reads as a different operation. Strings are therefore written as JSON
 * strings, quotes and all — a space, an `=` or a bracket inside one stays
 * inside the quotes — and the invisible and line-separating characters JSON
 * leaves alone are spelled out on top.
 *
 * UID lists are written whole, as IMAP ranges (`1:5,9`): the log is the only
 * way to reconstruct what a 200-UID delete took, and a list cut at twenty
 * entries cannot be.
 */
function format(value: unknown): string {
  if (Array.isArray(value)) {
    return value.every((entry) => Number.isInteger(entry))
      ? `[${uidRanges(value as number[])}]`
      : `[${value.map(format).join(',')}]`;
  }
  if (typeof value === 'string') return quote(value);
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return quote(String(value));
}

function quote(text: string): string {
  return escapeInvisible(JSON.stringify(text)).replace(
    /[\u2028\u2029]/g,
    (c) => `\\u${c.codePointAt(0)?.toString(16)}`
  );
}

/** `[1, 2, 3, 4, 5, 9]` as `1:5,9`. Sorted and de-duplicated. */
function uidRanges(uids: number[]): string {
  const sorted = [...new Set(uids)].toSorted((a, b) => a - b);
  const ranges: string[] = [];
  for (let i = 0; i < sorted.length;) {
    let end = i;
    while (sorted[end + 1] === (sorted[end] as number) + 1) end += 1;
    ranges.push(end === i ? String(sorted[i]) : `${sorted[i]}:${sorted[end]}`);
    i = end + 1;
  }
  return ranges.join(',');
}
